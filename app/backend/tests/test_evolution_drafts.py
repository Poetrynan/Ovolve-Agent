"""test_evolution_drafts.py - TDD tests for Ovolve self-evolution:
1. Default mode is MODE_CAUTIOUS (50% prudent intensity)
2. 1-Shot strong signal trigger (user_correction / preference triggers with 1 hit)
3. Dual-hash calculation (Payload-Hash & Content-Hash) and 3-state drafts (pending / approved / rejected)
4. propose_evolution_rule tool execution
5. Rejection cooldown prevents nagging
6. demote_ineffective_rules degrades weight and proposes retirement
"""
import os
import shutil
import tempfile
import pytest

from evolution import (
    EvolutionEngine,
    EvolutionStore,
    DEFAULT_MODE,
    MODE_CAUTIOUS,
    MODE_ACTIVE,
    MODE_OFF,
    Proposal,
    demote_ineffective_rules,
)
from evolution_tools import propose_evolution_rule, EvolutionDraftManager


@pytest.fixture
def temp_workspace():
    tmp = tempfile.mkdtemp(prefix="ovolve-evo-test-")
    yield tmp
    shutil.rmtree(tmp, ignore_errors=True)


def test_default_mode_is_cautious_and_enabled(temp_workspace):
    """Default mode is cautious (50% prudent), enabled out of the box."""
    assert DEFAULT_MODE == MODE_CAUTIOUS
    store = EvolutionStore(db_path=os.path.join(temp_workspace, "evolution.db"))
    engine = EvolutionEngine(store=store, workspace_root=temp_workspace)
    assert engine.mode == MODE_CAUTIOUS
    assert engine.enabled() is True


def test_one_shot_user_correction_triggers_proposal_immediately(temp_workspace):
    """1-Shot: user correction (strong signal) triggers a proposal on the first occurrence (hits=1)."""
    store = EvolutionStore(db_path=os.path.join(temp_workspace, "evolution.db"))
    engine = EvolutionEngine(store=store, mode=MODE_CAUTIOUS, workspace_root=temp_workspace)

    sig = engine.record_user_correction(
        turn_id="turn-1",
        correction_text="以后不要使用 npm，本项目统一强制使用 pnpm",
        session_id="session-test-1",
    )
    assert sig is not None

    # Mining should immediately produce a proposal because user_correction is a 1-shot strong signal
    proposals = engine.mine()
    assert len(proposals) == 1
    p = proposals[0]
    assert p.status == "pending"
    assert p.target_file == "MEMORY.md" or p.target_file == "AGENTS.md"
    assert "pnpm" in p.draft.lower() or "pnpm" in (p.user_advice or "").lower()


def test_dual_hash_and_three_state_drafts(temp_workspace):
    """Dual-hash (Payload-Hash, Content-Hash) and drafts in pending/approved/rejected."""
    store = EvolutionStore(db_path=os.path.join(temp_workspace, "evolution.db"))
    engine = EvolutionEngine(store=store, mode=MODE_CAUTIOUS, workspace_root=temp_workspace)

    draft_mgr = EvolutionDraftManager(workspace_root=temp_workspace)

    sig = engine.record(
        kind="user_correction",
        tool_name="terminal",
        detail="Always format code using ruff",
        session_id="sess-1",
    )
    proposals = engine.mine()
    assert len(proposals) == 1
    p = proposals[0]

    # Save draft
    draft_info = draft_mgr.save_pending_draft(p)
    assert draft_info["payload_hash"]
    assert draft_info["content_hash"]

    pending_file = os.path.join(temp_workspace, ".ovolve", "evolution", "pending", f"{p.id}.json")
    assert os.path.isfile(pending_file)

    # Approve moves to approved/
    draft_mgr.mark_approved(p.id)
    assert not os.path.isfile(pending_file)
    approved_file = os.path.join(temp_workspace, ".ovolve", "evolution", "approved", f"{p.id}.json")
    assert os.path.isfile(approved_file)


def test_propose_evolution_rule_tool(temp_workspace):
    """Agent tool propose_evolution_rule: actively propose an evolution rule with delivery_mode='card'."""
    store = EvolutionStore(db_path=os.path.join(temp_workspace, "evolution.db"))
    engine = EvolutionEngine(store=store, mode=MODE_CAUTIOUS, workspace_root=temp_workspace)

    res = propose_evolution_rule(
        target="AGENTS.md",
        signature="agents-use-pnpm-only",
        trigger_type="correction",
        confidence="high",
        reason="User said to never use npm",
        proposed_change="- 本项目统一使用 pnpm，严禁调用 npm install",
        delivery_mode="card",
        workspace_root=temp_workspace,
        engine=engine,
        session_id="sess-100",
    )

    assert res["status"] == "proposed"
    assert res["proposal_id"]
    assert res["delivery_mode"] == "card"
    assert res["payload_hash"]
    assert res["content_hash"]
    assert res["target"] == "AGENTS.md"

    # Verify open proposals in engine
    open_props = engine.list_open()
    assert any(p["id"] == res["proposal_id"] for p in open_props)


def test_rejected_cooldown_skips_duplicate_proposal(temp_workspace):
    """Rejection cooldown: same signature within 14 days is suppressed."""
    store = EvolutionStore(db_path=os.path.join(temp_workspace, "evolution.db"))
    engine = EvolutionEngine(store=store, mode=MODE_CAUTIOUS, workspace_root=temp_workspace)

    # Record and mine
    sig = engine.record_user_correction("t1", "Do not write test files to root", "s1")
    props = engine.mine()
    assert len(props) == 1
    p = props[0]

    # User rejects it
    engine.decide(p.id, accept=False)

    # Record again with same signature
    engine.record_user_correction("t2", "Do not write test files to root", "s1")
    props2 = engine.mine()
    # Suppressed by 14-day rejection cooldown
    assert len(props2) == 0


def test_demote_ineffective_rules(temp_workspace):
    """Ineffective rules are demoted by multiplying weight by 0.6."""
    store = EvolutionStore(db_path=os.path.join(temp_workspace, "evolution.db"))
    engine = EvolutionEngine(store=store, mode=MODE_CAUTIOUS, workspace_root=temp_workspace)

    # Prepare an accepted rule
    p = Proposal(
        id="prop-test-demote",
        signature="sig-ineffective-1",
        kind="tool_failure",
        tool_name="terminal",
        target_file="AGENTS.md",
        draft="- Avoid using rm -rf",
        rationale="test",
        hits=5,
        status="accepted",
        created_at=100.0,
        decided_at=150.0,
        applied=1,
    )
    store.insert_proposal(p)
    # Apply to AGENTS.md
    engine._apply_to_guidance(p)

    # Mark effect as ineffective
    store.record_effect_review(p.id, "ineffective", baseline=5, post=5)

    demoted = demote_ineffective_rules(engine)
    assert len(demoted) == 1
    assert demoted[0]["from"] == 1.0
    assert demoted[0]["to"] == 0.6
    assert demoted[0]["retire_proposal"] is False

    # Check updated draft in store
    updated = store.get_proposal(p.id)
    assert "<!-- evo:weight=0.6 -->" in updated.draft
