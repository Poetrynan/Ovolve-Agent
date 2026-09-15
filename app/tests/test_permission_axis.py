"""Tests for the single permission axis, now owned by ``risk_control``.

Three concerns to cover:
- ``coerce_permission`` must never crash on hostile input (bad frontend / typo /
  stale config.json) — it's the only entry point that turns user data into the enum.
- ``_global_risk_layer`` is where plan/readonly become a HARD write ban. If plan
  ever silently lets a write through, users lose trust in the whole thing.
- A DENY must survive a granted permission. That's the property that let the
  read-only lock move out of its own pre-gate and into the policy pipeline.

There used to be a second enum (``agent_modes.PermissionLevel``) with its own gate
running before the pipeline. Both are gone; these tests target the merged axis.
"""
import pytest

from risk_control import (
    DEFAULT_PERMISSION,
    PermissionMode,
    PolicyAction,
    PolicyRequest,
    RiskController,
    RiskLevel,
    coerce_permission,
    describe_permission,
    is_read_only,
    parse_consent,
    prompt_block,
)

READ = "read_text"        # LOW in TOOL_RISK_LEVELS
WRITE = "write_file"      # MEDIUM in TOOL_RISK_LEVELS
FORCE = "git_push_force"  # CRITICAL


@pytest.fixture(autouse=True)
def isolated_rules():
    """Every test runs against an empty in-memory rule store.

    Without this, exercising the real policy path would seed the shipped builtin
    rules into the developer's actual ~/.ovolve database, and one test's rule
    would leak into the next.
    """
    from permission_rules import PermissionRuleStore, set_permission_rules
    # Sibling test module. Two spellings because the suite gets run both ways:
    # `pytest ../tests` from app/backend imports this file as `tests.x` (package
    # mode, so relative works), while pointing pytest straight at app/tests
    # imports it top-level. A bare `from test_permission_rules import ...`
    # resolved in NEITHER case, which is why all 72 tests in this file were
    # erroring at fixture setup rather than running.
    try:
        from .test_permission_rules import FakeStorage
    except ImportError:
        from test_permission_rules import FakeStorage
    fake = FakeStorage()
    fake.kv_set("permission_rules_seeded", "1", ns="risk")  # skip builtins
    store = PermissionRuleStore(storage=fake)
    set_permission_rules(store)
    yield store
    set_permission_rules(None)


def decide(mode, tool, args=None, context=None):
    """Run the one layer that decides, and flatten it to (action, reason).

    Goes through the real ``RiskController`` rather than a stub so a change to
    the risk table or the mode branching shows up here.
    """
    rc = RiskController(mode=coerce_permission(mode))
    ctx = context if context is not None else {}
    d = rc._global_risk_layer(PolicyRequest(
        tool_name=tool, args=args or {}, context=ctx,
        risk_level=rc.classify_risk(tool, args).value,
    ))
    if d is None:
        return "allow", None
    return d.action.value, d.reason


# ── coerce ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("value,expected", [
    ("plan", PermissionMode.PLAN),
    ("FULL", PermissionMode.FULL),                        # case-insensitive
    (" readonly ", PermissionMode.READ_ONLY),             # whitespace tolerated
    (PermissionMode.CONFIRM, PermissionMode.CONFIRM),     # enum passes through
])
def test_coerce_accepts_valid_shapes(value, expected):
    assert coerce_permission(value) is expected


@pytest.mark.parametrize("value", [None, "", "  ", "bogus", 42, object()])
def test_coerce_falls_back_to_default_on_bad_input(value):
    """Never raise — a bad value from the frontend can't kill the turn."""
    assert coerce_permission(value) is DEFAULT_PERMISSION


@pytest.mark.parametrize("legacy,expected", [
    ("deny", PermissionMode.READ_ONLY),      # old risk_control vocabulary
    ("read_only", PermissionMode.READ_ONLY),
    ("ask", PermissionMode.CONFIRM),         # old agent_modes vocabulary
    ("ask_every", PermissionMode.CONFIRM),
    ("always", PermissionMode.CONFIRM),      # old approvalPolicy
    ("yolo", PermissionMode.FULL),
    ("never", PermissionMode.FULL),
    ("edit", PermissionMode.AUTO),           # old AgentMode values
    ("agent", PermissionMode.AUTO),
    ("build", PermissionMode.AUTO),
])
def test_coerce_maps_every_legacy_spelling(legacy, expected):
    """A persisted config.json or localStorage from before the merge must not
    silently change what the user picked."""
    assert coerce_permission(legacy) is expected


def test_legacy_deny_is_read_only_not_a_total_ban():
    """``deny`` was always a misnomer: it allowed reads. Renaming it to
    ``readonly`` must not change that."""
    assert is_read_only("deny")
    assert decide("deny", READ) == ("allow", None)


# ── read-only classification ───────────────────────────────────────────────

def test_plan_and_readonly_are_read_only():
    assert is_read_only(PermissionMode.PLAN)
    assert is_read_only("readonly")


def test_write_modes_are_not_read_only():
    for m in [PermissionMode.CONFIRM, PermissionMode.AUTO, PermissionMode.FULL]:
        assert not is_read_only(m), m


def test_ask_is_confirm_not_the_old_readonly_mode():
    """``ask`` means "confirm before writing", NOT the old read-only Ask *mode*.
    Reading it as read-only would strand users unable to write."""
    assert coerce_permission("ask") is PermissionMode.CONFIRM
    assert not is_read_only("ask")


# ── the decision layer: the hard guarantee ─────────────────────────────────

@pytest.mark.parametrize("mode", ["plan", "readonly"])
def test_reads_are_allowed_in_read_only_modes(mode):
    assert decide(mode, READ) == ("allow", None)


@pytest.mark.parametrize("mode", ["plan", "readonly"])
def test_writes_are_denied_in_read_only_modes(mode):
    action, reason = decide(mode, WRITE)
    assert action == "deny"
    assert WRITE in reason


def test_plan_refusal_tells_the_model_what_to_do_instead():
    """Refusal without direction just wastes a turn."""
    _, reason = decide("plan", WRITE)
    # Assert through describe_permission rather than a literal: the label is
    # product copy and gets reworded, the requirement ("name the档 you're in") does not.
    assert describe_permission(PermissionMode.PLAN) in reason
    assert "方案" in reason


def test_readonly_refusal_says_how_to_enable_writes():
    """If the user wants writes, they need to know how to turn them on."""
    _, reason = decide("readonly", WRITE)
    assert describe_permission(PermissionMode.READ_ONLY) in reason
    assert describe_permission(PermissionMode.CONFIRM) in reason


def test_full_allows_every_risk():
    for tool in [READ, WRITE, "shell_executor"]:
        assert decide("full", tool) == ("allow", None), tool


def test_confirm_asks_on_writes():
    action, reason = decide("confirm", WRITE)
    assert action == "ask"
    assert reason


def test_confirm_does_not_ask_about_reads():
    """Deliberate behaviour change in the merge. The old ``PermissionMode.CONFIRM``
    asked before a low-risk read too, which contradicted its own UI copy
    (「改文件前先问我」) and made the mode unusable. Reads now pass."""
    assert decide("confirm", READ) == ("allow", None)


def test_auto_allows_reads_and_asks_on_writes():
    assert decide("auto", READ) == ("allow", None)
    assert decide("auto", WRITE)[0] == "ask"


def test_write_modes_never_deny():
    for mode in ["confirm", "auto", "full"]:
        for tool in [READ, WRITE, "shell_executor"]:
            assert decide(mode, tool)[0] != "deny", (mode, tool)


def test_readonly_shell_command_is_a_read_even_in_plan():
    """``classify_risk`` downgrades a pure-read shell command to LOW, and plan
    must honour that — otherwise plan mode can't even run `git log`."""
    assert decide("plan", "shell_executor", {"command": "git log -1"}) == ("allow", None)


def test_writing_shell_command_is_still_denied_in_plan():
    action, _ = decide("plan", "shell_executor", {"command": "rm -rf build"})
    assert action == "deny"


# ── per-turn override vs the global default ────────────────────────────────

def test_per_turn_context_beats_the_global_mode():
    """The composer's dropdown is a per-turn choice riding on
    ``context['permission']``; Settings only sets the process-wide default."""
    action, _ = decide("full", WRITE, context={"permission": "plan"})
    assert action == "deny"


def test_per_turn_context_can_also_loosen():
    assert decide("confirm", WRITE, context={"permission": "full"}) == ("allow", None)


def test_missing_context_permission_uses_the_global_mode():
    assert decide("plan", WRITE, context={})[0] == "deny"
    assert decide("plan", WRITE, context={"permission": ""})[0] == "deny"


def test_bogus_context_permission_does_not_lock_the_session():
    """A garbage value must land on the default, not accidentally in
    READ_ONLY_MODES — that would leave the user unable to write with no
    dropdown position explaining why."""
    action, _ = decide("auto", WRITE, context={"permission": "nonsense_mode"})
    assert action == "ask"


# ── needs_confirmation agrees with the layer ───────────────────────────────

@pytest.mark.parametrize("mode,tool,expected", [
    ("auto", READ, False),
    ("auto", WRITE, True),
    ("full", WRITE, False),
    ("confirm", READ, False),
    ("confirm", WRITE, True),
    ("plan", READ, False),
    ("plan", WRITE, True),
])
def test_needs_confirmation_matches_the_deciding_layer(mode, tool, expected):
    """It used to re-implement the branching by hand and had already drifted.
    Now it delegates, so these must never disagree."""
    rc = RiskController(mode=coerce_permission(mode))
    assert rc.needs_confirmation(tool) is expected


# ── the property that let the lock move into the pipeline ──────────────────

def test_deny_survives_a_granted_permission():
    """The read-only lock moved out of its own pre-gate and into the GLOBAL
    policy layer. That's only safe because a DENY short-circuits the pipeline
    walk, so even an explicit grant on the INHERITED layer can't rescue it."""
    rc = RiskController(mode=PermissionMode.PLAN)
    args = {"path": "x.py", "content": "..."}
    ctx = {"session_id": "s1"}
    rc.grant_permission(WRITE, args, session_id="s1")
    result = rc.pipeline.evaluate(PolicyRequest(
        tool_name=WRITE, args=args, context=ctx,
        risk_level=rc.classify_risk(WRITE, args).value,
    ))
    assert result.action == PolicyAction.DENY


def test_grant_still_clears_an_ask_in_a_writable_mode():
    """Sanity: the grant path itself works where it's allowed to — a DENY isn't
    swallowing every grant."""
    rc = RiskController(mode=PermissionMode.CONFIRM)
    args = {"path": "x.py", "content": "..."}
    ctx = {"session_id": "s1"}
    rc.grant_permission(WRITE, args, session_id="s1")
    result = rc.pipeline.evaluate(PolicyRequest(
        tool_name=WRITE, args=args, context=ctx,
        risk_level=rc.classify_risk(WRITE, args).value,
    ))
    assert result.action == PolicyAction.ALLOW


# ── prompt injection ───────────────────────────────────────────────────────

def test_prompt_block_present_for_read_only_modes():
    assert describe_permission(PermissionMode.PLAN) in prompt_block(PermissionMode.PLAN)
    assert describe_permission(PermissionMode.READ_ONLY) in prompt_block(PermissionMode.READ_ONLY)


def test_prompt_block_differs_between_plan_and_readonly():
    """The two share a write ban but differ in INTENT — the prompt is the only
    place that difference lives."""
    ro = prompt_block(PermissionMode.READ_ONLY)
    plan = prompt_block(PermissionMode.PLAN)
    assert ro != plan
    assert "改动清单" in plan and "改动清单" not in ro


def test_prompt_block_empty_for_default_mode():
    """AUTO is the default and shouldn't inject anything."""
    assert prompt_block(PermissionMode.AUTO) == ""


def test_prompt_block_never_raises_on_bad_input():
    assert prompt_block(None) == ""
    assert prompt_block("bogus") == ""


# ── describe ───────────────────────────────────────────────────────────────

def test_describe_covers_all_modes():
    for m in PermissionMode:
        assert describe_permission(m)   # non-empty


def test_describe_falls_back_on_bad_input():
    assert describe_permission("nonsense") == describe_permission(DEFAULT_PERMISSION)


# ── CRITICAL: the floor that no mode and no rule can lower ──────────────────

def test_critical_still_asks_under_full_access():
    """完全访问 means "stop interrupting me", not "never stop me". An
    irreversible step is the one place that distinction has to hold."""
    action, reason = decide("full", FORCE)
    assert action == "ask"
    assert "不可逆" in reason


def test_force_flag_on_a_normal_push_is_critical_too():
    """The floor must not depend on the model choosing the scarier tool name."""
    assert decide("full", "git_push", {"force": True})[0] == "ask"
    assert decide("full", "git_push", {})[0] == "allow"


def test_critical_is_still_denied_in_plan():
    """Read-only outranks the critical ask: in 计划模式 nothing writes at all,
    so there is nothing to ask about."""
    assert decide("plan", FORCE)[0] == "deny"


def test_an_allow_rule_cannot_silence_critical(isolated_rules):
    from permission_rules import PermissionRule, RuleScope
    isolated_rules.add(PermissionRule(tool_name=FORCE, pattern="",
                                      scope=RuleScope.GLOBAL))
    assert decide("full", FORCE)[0] == "ask"


def test_always_allow_refuses_to_whitelist_a_critical_call():
    """「以后都允许」 on a force-push has to be a no-op, not a permanent hole."""
    rc = RiskController(mode=PermissionMode.AUTO)
    rc.record_pending("c1", FORCE, {"remote": "origin"}, "?", "s1")
    rc.resolve_pending("approve_always", "s1")
    assert rc._match_rule(PolicyRequest(
        tool_name=FORCE, args={"remote": "origin"}, context={"session_id": "s1"},
    )) is None


# ── standing rules through the real policy path ─────────────────────────────

def test_allow_rule_removes_the_auto_mode_ask(isolated_rules):
    """The capability this whole subsystem exists for: the agent's verify step
    stops interrupting the user."""
    from permission_rules import PermissionRule, RuleScope
    assert decide("auto", "shell_executor", {"command": "pytest tests/"})[0] == "ask"
    isolated_rules.add(PermissionRule(tool_name="shell_executor", pattern="pytest *",
                                      scope=RuleScope.GLOBAL))
    assert decide("auto", "shell_executor", {"command": "pytest tests/"})[0] == "allow"


def test_allow_rule_matches_the_class_not_one_call(isolated_rules):
    from permission_rules import PermissionRule, RuleScope
    isolated_rules.add(PermissionRule(tool_name="shell_executor", pattern="pytest *",
                                      scope=RuleScope.GLOBAL))
    for cmd in ("pytest a.py", "pytest b.py -q", "pytest"):
        assert decide("auto", "shell_executor", {"command": cmd})[0] == "allow", cmd


def test_allow_rule_does_not_unlock_plan_mode(isolated_rules):
    """A rule written last week must not override this turn's deliberate choice."""
    from permission_rules import PermissionRule, RuleScope
    isolated_rules.add(PermissionRule(tool_name=WRITE, pattern="",
                                      scope=RuleScope.GLOBAL))
    assert decide("plan", WRITE)[0] == "deny"


def test_deny_rule_beats_full_access(isolated_rules):
    from permission_rules import PermissionRule, RuleBehavior, RuleScope
    isolated_rules.add(PermissionRule(tool_name=WRITE, pattern="",
                                      behavior=RuleBehavior.DENY,
                                      scope=RuleScope.GLOBAL))
    action, reason = decide("full", WRITE)
    assert action == "deny"
    assert "规则" in reason


def test_ask_rule_reinstates_a_question_full_access_would_skip(isolated_rules):
    from permission_rules import PermissionRule, RuleBehavior, RuleScope
    isolated_rules.add(PermissionRule(tool_name=WRITE, pattern="",
                                      behavior=RuleBehavior.ASK,
                                      scope=RuleScope.GLOBAL))
    assert decide("full", WRITE)[0] == "ask"


def test_a_broken_rule_store_degrades_to_the_risk_table(monkeypatch):
    """A locked or corrupt DB must not take down every tool call."""
    import permission_rules

    def boom():
        raise RuntimeError("db is on fire")

    monkeypatch.setattr(permission_rules, "get_permission_rules", boom)
    assert decide("auto", WRITE)[0] == "ask"
    assert decide("auto", READ)[0] == "allow"


def test_approve_always_writes_a_rule_that_clears_the_next_call():
    """End to end: one 「以后都允许」 and the same class of call stops asking."""
    from permission_rules import PermissionRuleStore, set_permission_rules
    try:
        from .test_permission_rules import FakeStorage
    except ImportError:
        from test_permission_rules import FakeStorage
    fake = FakeStorage()
    fake.kv_set("permission_rules_seeded", "1", ns="risk")
    set_permission_rules(PermissionRuleStore(storage=fake))
    try:
        rc = RiskController(mode=PermissionMode.AUTO)
        args = {"command": "pytest tests/a.py"}
        rc.record_pending("c1", "shell_executor", args, "?", "s1")
        rc.resolve_pending("approve_always", "s1")
        # A DIFFERENT argument — the exact case a per-args grant re-asks about.
        assert rc.needs_confirmation(
            "shell_executor", {"command": "pytest tests/b.py"},
            {"session_id": "s1"},
        ) is False
    finally:
        set_permission_rules(None)


def test_consent_parsing_distinguishes_always_from_once():
    assert parse_consent("同意") == "approve"
    assert parse_consent("以后都允许") == "approve_always"
    assert parse_consent("always") == "approve_always"
    assert parse_consent("不同意") == "deny"
    assert parse_consent("同意，但先备份一下") is None


# ── answering a SPECIFIC parked ask (what the card buttons buy us) ───────────

def test_call_id_answers_the_card_it_was_on_not_the_newest():
    """Typed consent can only ever address the newest ask — that's all text
    carries. A clicked answer ships the call_id, so a user with two parked
    confirmations can actually say which one they meant."""
    rc = RiskController(mode=PermissionMode.AUTO)
    a = {"path": "a.py", "content": "1"}
    b = {"path": "b.py", "content": "2"}
    rc.record_pending("call-a", WRITE, a, "?", "s1")
    rc.record_pending("call-b", WRITE, b, "?", "s1")

    answered = rc.resolve_pending("approve", "s1", "call-a")
    assert answered is not None and answered.call_id == "call-a"
    # The older card was approved; the newer one is still waiting.
    assert rc.has_grant(WRITE, a, {"session_id": "s1"}) is True
    assert rc.has_grant(WRITE, b, {"session_id": "s1"}) is False
    assert [p.call_id for p in rc.pending_for("s1")] == ["call-b"]


def test_no_call_id_still_answers_the_newest():
    """The typed path must keep working unchanged."""
    rc = RiskController(mode=PermissionMode.AUTO)
    rc.record_pending("call-a", WRITE, {"path": "a.py"}, "?", "s1")
    rc.record_pending("call-b", WRITE, {"path": "b.py"}, "?", "s1")
    answered = rc.resolve_pending("approve", "s1")
    assert answered.call_id == "call-b"


def test_denying_one_card_does_not_grant_the_other():
    rc = RiskController(mode=PermissionMode.AUTO)
    a = {"path": "a.py"}
    rc.record_pending("call-a", WRITE, a, "?", "s1")
    rc.resolve_pending("deny", "s1", "call-a")
    assert rc.has_grant(WRITE, a, {"session_id": "s1"}) is False
    assert rc.pending_for("s1") == []
