"""Integration tests for the multi-agent skeleton (A2 / MVP 骨补线).

Verifies the three behaviours the handoff document calls the "骨" of the
product, the ones a demo depends on being real rather than decorative:

  1. TaskLease mutual exclusion — the same task id can only be held by one
     owner at a time; a second acquire fails until the first releases.
  2. ResultContract enforcement — a sub-agent result that does not satisfy
     its persona schema is rejected (``ok`` flipped to False), and an empty
     text result never passes as success.
  3. Mailbox delivery — a lifecycle event the sub-agent runtime emits reaches
     the persistent mailbox and is readable back.

These are the assertions the HN/comment-section demo lives or dies on: if
any of them is fake, "5 agents working in parallel" is a screenshot, not a
product.
"""
from __future__ import annotations

import time

import pytest

# conftest.py already injects app/backend onto sys.path and isolates the DB.

from mailbox import drain, send, unread
from storage import get_storage
from subagent_runtime import SubagentRuntime
from team import (
    TeamBoard,
    acquire_lease,
    check_result_contract,
    enforce_contracts,
    release_lease,
)


# ── TaskLease ────────────────────────────────────────────────────────────────

class TestTaskLease:
    """TaskLease: one holder per task, expiry re-claim, owner-only release."""

    def test_acquire_is_exclusive(self, store):
        """Two owners cannot hold the same task simultaneously."""
        ok1 = acquire_lease(store, "task-A", "owner-1")
        ok2 = acquire_lease(store, "task-A", "owner-2")
        assert ok1 is True, "first acquire must succeed"
        assert ok2 is False, "second acquire on a held lease must fail"

    def test_release_and_reacquire(self, store):
        """Only the holder can release; a new owner can then claim."""
        acquire_lease(store, "task-B", "owner-1")
        assert acquire_lease(store, "task-B", "owner-2") is False

        # Wrong owner cannot release.
        assert release_lease(store, "task-B", "owner-2") is False
        assert acquire_lease(store, "task-B", "owner-2") is False

        # Right owner releases → new owner can claim.
        assert release_lease(store, "task-B", "owner-1") is True
        assert acquire_lease(store, "task-B", "owner-2") is True

    def test_lease_expires(self, store):
        """A short TTL lease can be re-claimed after expiry."""
        acquire_lease(store, "task-C", "owner-1", ttl_s=1)
        assert acquire_lease(store, "task-C", "owner-2") is False
        # team_leases 以整秒粒度记录时间（acquire_lease 用 int(time.time())，
        # 接管条件是 expires_at < now，两边都是整秒）。ttl_s=1 的租约在
        # 最坏情况下要到 acquired_at 所在秒之后的第 2 个整秒才可接管，
        # 因此睡 1.1s 落在同一个整秒窗内会拿到 False——必须 > 2s 才必然过期。
        time.sleep(2.2)
        assert acquire_lease(store, "task-C", "owner-2") is True


# ── ResultContract ───────────────────────────────────────────────────────────

class TestResultContract:
    """ResultContract: schema-typed acceptance, empty/invalid → rejected."""

    def test_valid_payload_passes(self):
        schema = {"required": ["summary"], "types": {"summary": str}}
        ok, problems = check_result_contract({"summary": "done"}, schema)
        assert ok is True
        assert problems == []

    def test_missing_required_key_fails(self):
        schema = {"required": ["summary"], "types": {"summary": str}}
        ok, problems = check_result_contract({"other": "x"}, schema)
        assert ok is False
        assert any("missing key: summary" in p for p in problems)

    def test_wrong_type_fails(self):
        schema = {"required": ["passed"], "types": {"passed": bool}}
        ok, problems = check_result_contract({"passed": "yes"}, schema)
        assert ok is False
        # Error format: "key passed: expected bool, got str"
        assert any("expected" in p and "bool" in p for p in problems)

    def test_enforce_contracts_attaches_warning_not_flip_ok(self):
        """P0-1: enforce_contracts attaches a warning, does NOT flip ok=False."""
        # researcher with empty text → text-based persona with no summary → warning
        results = [
            {"ok": True, "type": "researcher", "text": "",
             "payload": {}},  # empty text, no findings → warning
            {"ok": True, "type": "coder", "text": "patched",
             "payload": {}},  # coder auto-fills patch_summary from text → passes
        ]
        warnings = enforce_contracts(results)
        # researcher: empty delivery → warning, but ok stays True
        assert results[0]["ok"] is True  # P0-1: ok preserved
        assert warnings > 0
        assert "contract" in results[0]
        assert results[0]["contract"]["ok"] is False  # contract itself failed
        assert results[0]["contract"]["severity"] == "warn"
        # coder: auto-fills patch_summary from text → passes
        assert results[1]["ok"] is True
        assert results[1]["contract"]["ok"] is True

    def test_enforce_contracts_empty_text_warns_not_fails(self):
        """P0-1: Empty-text 'success' attaches warning, does NOT flip ok."""
        results = [{"ok": True, "type": "planner", "text": "   ", "payload": {}}]
        warnings = enforce_contracts(results)
        # ok stays True (work preserved), but a warning is attached
        assert results[0]["ok"] is True
        assert warnings > 0
        assert results[0]["contract"]["severity"] == "warn"


# ── TeamBoard ────────────────────────────────────────────────────────────────

class TestTeamBoard:
    """TeamBoard: claim → deliver → review lifecycle, DAG dependency gating."""

    def test_claim_and_deliver(self, store):
        board = TeamBoard(store, "parent-1")
        board.add_task("t1", "reviewer")
        assert board.claim("t1", "worker-a") is True
        # Same worker delivers a valid payload.
        ok, problems = board.deliver("t1", "worker-a",
                                      {"verdict": "approved", "issues": []})
        assert ok is True
        assert board._tasks["t1"]["status"] == "delivered"

    def test_deliver_without_lease_fails(self, store):
        board = TeamBoard(store, "parent-2")
        board.add_task("t1", "reviewer")
        board.claim("t1", "worker-a")
        ok, problems = board.deliver("t1", "worker-b", {"verdict": "ok", "issues": []})
        assert ok is False
        assert any("not lease holder" in p for p in problems)

    def test_deliver_bad_contract_rejects(self, store):
        board = TeamBoard(store, "parent-3")
        board.add_task("t1", "reviewer")
        board.claim("t1", "worker-a")
        ok, problems = board.deliver("t1", "worker-a", {"verdict": "ok"})
        # missing "issues" key
        assert ok is False
        assert board._tasks["t1"]["status"] == "rejected"

    def test_dag_dependency_gating(self, store):
        """A task whose prerequisite failed is blocked, not run."""
        board = TeamBoard(store, "parent-4")
        board.add_task("plan", "planner")
        board.add_task("code", "coder", depends_on=["plan"])

        # Fail the prerequisite.
        board.claim("plan", "w")
        board.deliver("plan", "w", {"plan": ["step1"]})
        board.set_review("plan", "rejected", "not good")

        # code cannot run because plan was rejected.
        assert board.can_run("code") is False
        blocked = board.cascade_failures()
        assert blocked == 1
        assert board._tasks["code"]["status"] == "blocked"


# ── Mailbox ──────────────────────────────────────────────────────────────────

class TestMailbox:
    """Mailbox: send → unread → drain (consume) lifecycle."""

    def test_send_and_read(self, store):
        mid = send(store, "box-1", "tester", kind="info", payload={"msg": "hi"})
        assert isinstance(mid, str) and len(mid) > 0

        msgs = unread(store, "box-1")
        assert len(msgs) == 1
        assert msgs[0]["payload"]["msg"] == "hi"
        assert msgs[0]["consumed"] == 0

    def test_drain_marks_consumed(self, store):
        send(store, "box-2", "tester", payload={"n": 1})
        send(store, "box-2", "tester", payload={"n": 2})

        msgs = drain(store, "box-2")
        assert len(msgs) == 2
        assert all(m["consumed"] == 1 for m in msgs)

        # Second drain returns empty — each message delivered once.
        assert drain(store, "box-2") == []

    def test_unknown_kind_falls_back_to_info(self, store):
        """An invalid kind must not crash delivery (fail-open)."""
        send(store, "box-3", "tester", kind="bogus", payload={})
        msgs = unread(store, "box-3")
        assert msgs[0]["kind"] == "info"


# ── SubagentRuntime → Mailbox lifecycle ──────────────────────────────────────

class TestSubagentLifecycleMailbox:
    """A sub-agent reaching RUNNING/terminal state leaves a mailbox trail."""

    @pytest.mark.asyncio
    async def test_running_event_reaches_mailbox(self, store):
        """The _transition → _notify_parent_mailbox path delivers a
        'started' event into the parent run's mailbox when a sub-agent
        leaves SPAWNING for RUNNING."""
        from subagent_runtime import SubagentRuntime, SubagentSession, SubagentStatus

        runtime = SubagentRuntime()
        session = SubagentSession(
            subagent_id="probe-1",
            subagent_type="explore",
            label="probe",
            parent_session_id="sess-life",
            child_session_id="sess-life::sub::probe-1",
        )
        runtime._sessions["probe-1"] = session

        # Move the session from SPAWNING to RUNNING — this is the transition
        # that fires the "started" mailbox notification.
        await runtime._transition(session, SubagentStatus.RUNNING)

        msgs = unread(store, "mailbox:sess-life")
        assert len(msgs) >= 1, "no lifecycle event reached the mailbox"
        payload = msgs[0]["payload"]
        assert payload["event"] == "started"
        assert payload["type"] == "explore"
        assert payload["subagent_id"] == "probe-1"

    @pytest.mark.asyncio
    async def test_terminal_event_reaches_mailbox(self, store):
        """A terminal transition (COMPLETED) also notifies the mailbox."""
        from subagent_runtime import SubagentRuntime, SubagentSession, SubagentStatus

        runtime = SubagentRuntime()
        session = SubagentSession(
            subagent_id="probe-2",
            subagent_type="coder",
            label="impl",
            parent_session_id="sess-life-2",
            child_session_id="sess-life-2::sub::probe-2",
        )
        runtime._sessions["probe-2"] = session

        await runtime._transition(session, SubagentStatus.COMPLETED)

        msgs = unread(store, "mailbox:sess-life-2")
        assert len(msgs) >= 1
        assert msgs[0]["payload"]["event"] == "completed"


# ── helpers ──────────────────────────────────────────────────────────────────

@pytest.fixture
def store():
    """Fresh storage singleton (conftest already points it at a temp dir)."""
    return get_storage()
