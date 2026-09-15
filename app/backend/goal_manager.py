"""
goal_manager.py - Long-term goal and sub-goal lifecycle manager.

Manages long-running goals with iterations, sub-tasks, state tracking,
and automatic continuation when LLM verification fails.

Key feature: goal-continuation auto-resume
  - verify_completion() uses LLM to check if goal is truly done
  - continue_goal() injects system reminder to keep working
  - max_iterations prevents infinite loops
  - goal_state persisted in sessions table
"""
from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from enum import Enum
from typing import Any, Callable, Optional

from result import Result
from storage import get_storage
from telemetry import get_telemetry, SpanName
from goal_brief import GoalBrief, GoalCategory, derive_goal_category, build_brief_from_prompt, CATEGORY_DEFAULTS


class GoalStatus:
    """Goal lifecycle states.

    ``STARTED`` and ``ACTIVE`` are equivalent running states.
    Use ``ACTIVE_STATES`` when testing "is this goal still running".

    The stop path is a real state machine, not a flag:
    ``running → stopping → paused``. A stop request that cannot be confirmed
    within the grace window lands in ``stop_timeout``, NOT paused — writing
    paused there was how the UI ended up showing 已暂停 over a worker that was
    still spending money. stop_timeout leaves via :meth:`confirm stopped`
    (worker verifiably gone → paused) or a successful retry of the pause.
    """
    STARTED = "started"
    ACTIVE = "active"
    #: Handed to the scheduler but waiting for a free worker slot.
    QUEUED = "queued"
    #: A scheduler worker is currently driving this goal.
    RUNNING = "running"
    #: A stop has been requested: hard-cancel sent, worker cancel() issued,
    #: confirmation not yet received. No new round may start, run/resume are
    #: refused, and the UI should show live calls + what has been killed.
    STOPPING = "stopping"
    #: The confirmed resting state: worker task finished unwinding, all
    #: killable child processes are gone.
    PAUSED = "paused"
    #: The grace window elapsed and the goal could NOT be confirmed stopped —
    #: some tool thread or child process is still alive. Deliberately distinct
    #: from PAUSED: resume stays blocked until the user (or the confirm
    #: endpoint) establishes that nothing is really running any more.
    STOP_TIMEOUT = "stop_timeout"
    COMPLETED = "completed"
    FAILED = "failed"
    FAILED_FINAL = "ovolve_failed_final"  # terminal failure, not retried
    CANCELLED = "cancelled"


#: States that mean the goal is still running. ``RUNNING`` has to be in here:
#: the scheduler marks a claimed goal ``running``, and ``continue_goal`` refuses
#: to continue anything outside this set — so omitting it made every scheduled
#: goal die on its first continuation with "Goal is not active: running".
ACTIVE_STATES = {
    GoalStatus.STARTED, GoalStatus.ACTIVE, GoalStatus.RUNNING, GoalStatus.QUEUED,
}


class GoalType(Enum):
    """Goal provenance/type classification."""
    BACKGROUND_TASK = "ovolve_background_task"
    FORK = "ovolve_fork"
    GOAL_STATE_CHANGE = "ovolve_goal_state_change"
    GOAL_CONTINUATION = "ovolve_auto_resume"  # the auto-resume type
    REWIND = "ovolve_rewind"
    SUBAGENT = "ovolve_sub_agent"
    TODO_REMINDER = "ovolve_reminder"


class Goal:
    """A long-running goal with iterations and sub-goals."""

    def __init__(self, description: str, priority: int = 0,
                 goal_type: "GoalType | str" = GoalType.BACKGROUND_TASK) -> None:
        self.id: str = str(uuid.uuid4())
        self.description: str = description
        self.priority: int = priority
        self.status: str = GoalStatus.STARTED
        self.goal_type: str = goal_type.value if isinstance(goal_type, GoalType) else str(goal_type)
        self.created_at: float = time.time()
        self.updated_at: float = time.time()
        self.iterations: list[dict] = []
        self.sub_goals: list[Goal] = []
        self.metadata: dict = {}
        self.continuation_count: int = 0
        self.max_continuations: int = 10

    def add_iteration(self, result: str, status: str = "progress") -> None:
        """Add an iteration record to this goal.

        Args:
            result: Result description of this iteration.
            status: Status of the iteration (progress/completed/failed).
        """
        self.iterations.append({
            "timestamp": time.time(),
            "result": result,
            "status": status,
        })
        self.updated_at = time.time()

    def add_sub_goal(self, description: str) -> "Goal":
        """Add a sub-goal.

        Args:
            description: Sub-goal description.

        Returns:
            The created sub-goal.
        """
        sub = Goal(description)
        self.sub_goals.append(sub)
        return sub

    @property
    def remaining_sub_goals(self) -> list[Goal]:
        """Sub-goals that are still active.

        ACTIVE_STATES, not a bare `== ACTIVE`: the scheduler marks claimed
        goals QUEUED/RUNNING and some paths use STARTED, so a bare equality
        made in-flight sub-goals count as finished and broke progress math.
        """
        return [g for g in self.sub_goals if g.status in ACTIVE_STATES]

    def to_dict(self) -> dict:
        """Serialize to dictionary for storage."""
        return {
            "id": self.id,
            "description": self.description,
            "priority": self.priority,
            "status": self.status,
            "goal_type": self.goal_type,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "iterations": self.iterations,
            "sub_goals": [g.to_dict() for g in self.sub_goals],
            "metadata": self.metadata,
            "continuation_count": self.continuation_count,
            "max_continuations": self.max_continuations,
        }

    @staticmethod
    def from_dict(d: dict) -> "Goal":
        """Deserialize from storage dict."""
        g = Goal(d.get("description", ""), d.get("priority", 0),
                 d.get("goal_type", GoalType.BACKGROUND_TASK.value))
        g.id = d.get("id", str(uuid.uuid4()))
        g.status = d.get("status", GoalStatus.STARTED)
        g.created_at = d.get("created_at", time.time())
        g.updated_at = d.get("updated_at", time.time())
        g.iterations = d.get("iterations", [])
        g.metadata = d.get("metadata", {})
        g.continuation_count = d.get("continuation_count", 0)
        g.max_continuations = d.get("max_continuations", 10)
        for sg in d.get("sub_goals", []):
            g.sub_goals.append(Goal.from_dict(sg))
        return g


class GoalManager:
    """Manage long-term goals with persistence, iteration tracking, and auto-continuation.

    Features:
      - 5-state status machine (active/paused/completed/failed/cancelled)
      - LLM-based completion verification
      - Auto-continuation with system reminder injection
      - goal_state persisted in sessions table
      - max_iterations safeguard against infinite loops
    """

    def __init__(self, llm_callback: Optional[Callable] = None) -> None:
        self.storage = get_storage()
        self.telemetry = get_telemetry()
        self._llm = llm_callback
        self._active_goal: Optional[str] = None
        self._session_id: Optional[str] = None
        self._workspace: str = ""

    def set_session(self, session_id: str) -> None:
        """Bind the goal manager to a session.

        Args:
            session_id: Session identifier.
        """
        self._session_id = session_id

    def set_workspace(self, workspace: str) -> None:
        """Bind the goal manager to a workspace directory."""
        self._workspace = str(workspace or "")

    def create_goal(self, description: str, priority: int = 0,
                    brief: "GoalBrief | dict | None" = None) -> Goal:
        """Create a new goal, always with a structured brief attached (D1).

        A goal without a brief is a goal nobody can verify — the model gets to
        decide what "done" means, which is how a half-finished task gets marked
        complete. So when the caller supplies no brief we derive one from the
        description rather than leaving the contract empty.

        Args:
            description: Goal description (the human one-liner).
            priority: Priority level (higher = more important).
            brief: Optional structured contract. Accepts a ``GoalBrief`` or the
                camelCase dict the frontend/LLM produces. Derived from
                ``description`` when omitted.

        Returns:
            The created Goal object, with ``metadata['brief']`` populated.
        """
        goal = Goal(description, priority)

        resolved = self._resolve_brief(description, brief)
        goal.metadata["brief"] = resolved.to_dict()
        goal.metadata["category"] = resolved.category.value

        # Category-derived defaults. An explicit brief that carries its own
        # ceiling wins; otherwise the category picks a sane cap so a research
        # goal can't burn a code goal's budget.
        defaults = resolved.get_defaults()
        goal.max_continuations = defaults["max_iter"]

        self.storage.save_goal(
            goal.id, goal.description, goal.status,
            0, self._session_id or "", "",
        )
        # brief_json / category / caps live outside save_goal's five core fields.
        self.storage.update_goal_fields(
            goal.id,
            brief_json=json.dumps(resolved.to_dict(), ensure_ascii=False),
            category=resolved.category.value,
            max_iterations=defaults["max_iter"],
            cost_cap_micros=defaults["cost_cap_micros"],
        )

        # 契约先行 (Contract-First / ProgramBench)：初始化可执行验收契约
        from acceptance_contract import normalize_contract, set_goal_contract
        contract = normalize_contract({
            "summary": description,
            "deliverables": resolved.deliverables,
            "acceptance_criteria": resolved.acceptance_criteria,
            "required_artifacts": [d for d in resolved.deliverables if "." in d or "/" in d],
            "verification_plan": [],
        }, goal.id)
        set_goal_contract(self.storage, goal.id, contract)

        self._active_goal = goal.id
        self._persist_goal_state()
        return goal

    def _resolve_brief(self, description: str,
                       brief: "GoalBrief | dict | None") -> GoalBrief:
        """Normalize whatever the caller passed into a valid GoalBrief.

        Order of preference: an explicit valid brief → an explicit brief with
        gaps patched from the description → a fully derived brief. The category
        is re-derived whenever it is missing or ``unknown`` so a brief authored
        by hand still gets routed correctly.
        """
        if brief is None:
            return build_brief_from_prompt(description)

        resolved = brief if isinstance(brief, GoalBrief) else GoalBrief.from_dict(brief)

        # Patch the two required fields rather than rejecting the brief — a
        # partially-filled brief is still more useful than a derived one.
        if not resolved.summary.strip():
            resolved.summary = build_brief_from_prompt(description).summary
        if not resolved.deliverables:
            resolved.deliverables = ["完成用户请求的任务"]
        if not resolved.raw_prompt:
            resolved.raw_prompt = description
        if resolved.category == GoalCategory.UNKNOWN:
            resolved.category = derive_goal_category(
                resolved.summary, resolved.deliverables, resolved.raw_prompt,
            )
        return resolved

    def get_brief(self, goal_id: str) -> Optional[GoalBrief]:
        """Load a goal's structured brief.

        Returns:
            The ``GoalBrief``, or None when the goal is missing or predates the
            brief contract (old rows carry ``'{}'``).
        """
        r = self.storage.get_goal(goal_id)
        if r is None:
            return None
        raw = r.get("brief_json") or ""
        if not raw or raw == "{}":
            # Backfill on read: an old goal still gets a usable contract, and we
            # persist it so the next reader doesn't have to re-derive.
            derived = build_brief_from_prompt(r.get("description", ""))
            self.storage.update_goal_fields(
                goal_id,
                brief_json=json.dumps(derived.to_dict(), ensure_ascii=False),
                category=derived.category.value,
            )
            return derived
        try:
            return GoalBrief.from_dict(json.loads(raw))
        except (json.JSONDecodeError, TypeError, ValueError):
            return None

    def set_brief(self, goal_id: str, brief: "GoalBrief | dict") -> Result:
        """Replace a goal's brief (e.g. after the user edits it in review).

        Rejects an invalid brief instead of writing it — a brief with no
        deliverable would silently disable verification.
        """
        r = self.storage.get_goal(goal_id)
        if r is None:
            return Result.failure(f"Goal not found: {goal_id}")
        resolved = brief if isinstance(brief, GoalBrief) else GoalBrief.from_dict(brief)
        ok, why = resolved.is_valid()
        if not ok:
            return Result.failure(f"Invalid goal brief: {why}")
        if resolved.category == GoalCategory.UNKNOWN:
            resolved.category = derive_goal_category(
                resolved.summary, resolved.deliverables, resolved.raw_prompt,
            )
        self.storage.update_goal_fields(
            goal_id,
            brief_json=json.dumps(resolved.to_dict(), ensure_ascii=False),
            category=resolved.category.value,
        )
        return Result.success(resolved.to_dict())

    def get_goal(self, goal_id: str) -> Result:
        """Get goal by ID.

        Args:
            goal_id: Goal identifier.

        Returns:
            Result containing goal dict on success.
        """
        r = self.storage.get_goal(goal_id)
        if r is None:
            return Result.failure(f"Goal not found: {goal_id}")
        return Result.success(r)

    def list_goals(self, status: Optional[str] = None) -> list[dict]:
        """List all goals, optionally filtered by status.

        Args:
            status: Optional status filter.

        Returns:
            List of goal dicts.
        """
        return self.storage.list_goals(status)

    def update_goal_status(self, goal_id: str, status: str) -> Result:
        """Update goal status.

        Args:
            goal_id: Goal identifier.
            status: New status.

        Returns:
            Result indicating success or failure.
        """
        r = self.storage.get_goal(goal_id)
        if r is None:
            return Result.failure(f"Goal not found: {goal_id}")
        self.storage.save_goal(
            goal_id, r.get("description", ""), status,
            r.get("iteration", 0), r.get("session_id", ""),
            r.get("verification_result", ""),
        )
        return Result.success(f"Status updated to: {status}")

    def add_iteration(self, goal_id: str, result: str, status: str = "progress") -> Result:
        """Add an iteration to a goal.

        Args:
            goal_id: Goal identifier.
            result: Iteration result description.
            status: Iteration status.

        Returns:
            Result indicating success or failure.
        """
        span = self.telemetry.start_span(SpanName.GOAL_ITERATION, goal_id=goal_id)
        try:
            r = self.storage.get_goal(goal_id)
            if r is None:
                span.set_error("Goal not found")
                return Result.failure(f"Goal not found: {goal_id}")
            iteration = r.get("iteration", 0) + 1
            self.storage.save_goal(
                goal_id, r.get("description", ""), r.get("status", "active"),
                iteration, r.get("session_id", ""),
                r.get("verification_result", ""),
            )
            self.telemetry.end_span(span, iteration=iteration)
            return Result.success({"iteration": iteration, "result": result})
        except Exception as e:
            span.set_error(str(e))
            self.telemetry.end_span(span)
            return Result.failure(f"Failed to add iteration: {e}")

    def set_active_goal(self, goal_id: str) -> Result:
        """Set the currently active goal.

        Args:
            goal_id: Goal identifier.

        Returns:
            Result with goal description.
        """
        r = self.storage.get_goal(goal_id)
        if r is None:
            return Result.failure(f"Goal not found: {goal_id}")
        self._active_goal = goal_id
        self._persist_goal_state()
        return Result.success(f"Active goal set to: {r.get('description')}")

    def get_active_goal(self) -> Optional[str]:
        """Get the active goal ID.

        Returns:
            Active goal ID or None.
        """
        return self._active_goal

    def get_active_goal_context(self) -> Optional[str]:
        """Build a system reminder for the active goal.

        Renders the structured brief when one exists so the agent sees the actual
        acceptance criteria instead of just a description — a bare "continue
        working on this" reminder is what lets a goal drift off-target.

        Returns:
            Formatted system reminder string, or None if no active goal.
        """
        if not self._active_goal:
            return None
        r = self.storage.get_goal(self._active_goal)
        if r is None:
            return None
        if r.get("status") not in ACTIVE_STATES:
            return None
        iteration = r.get("iteration", 0)
        ver_raw = r.get("verification_result", "")

        brief = self.get_brief(self._active_goal)
        parts = []
        if brief is not None:
            parts.append(brief.system_context())
            parts.append(f"(iteration {iteration})")
        else:
            parts.append(f'Goal "{r.get("description", "")}" is active (iteration {iteration}).')

        ver = {}
        if ver_raw:
            try:
                ver = json.loads(ver_raw) if isinstance(ver_raw, str) else ver_raw
            except Exception:
                ver = {}

        if isinstance(ver, dict) and ver.get("unmet"):
            parts.append("\n[CRITICAL - ANTI-EARLY-QUIT GATE FAILED]")
            parts.append("The machine verification gate detected unfulfilled criteria:")
            for u in ver["unmet"][:5]:
                parts.append(f"  - {u}")
            parts.append("You MUST resolve these specific failures before attempting to complete the task.")
        elif ver_raw:
            parts.append(f"Last verification: {ver_raw}")

        parts.append("Please continue working on this goal.")
        return "\n".join(parts)

    def _persist_goal_state(self) -> None:
        """Persist goal state to the sessions table."""
        if not self._session_id:
            return
        state = {
            "current_goal_id": self._active_goal,
            "status": "active" if self._active_goal else "idle",
        }
        self.storage.set_goal_state(self._session_id, state)

    def load_goal_state(self, session_id: str) -> Optional[dict]:
        """Load goal state from sessions table.

        Args:
            session_id: Session identifier.

        Returns:
            Goal state dict or None.
        """
        self._session_id = session_id
        state = self.storage.get_goal_state(session_id)
        if state:
            self._active_goal = state.get("current_goal_id")
        return state

    def pause_goal(self, goal_id: str) -> Result:
        """Pause a goal.

        Args:
            goal_id: Goal identifier.

        Returns:
            Result indicating success.
        """
        return self.update_goal_status(goal_id, GoalStatus.PAUSED)

    def resume_goal(self, goal_id: str) -> Result:
        """Resume a paused goal.

        Args:
            goal_id: Goal identifier.

        Returns:
            Result indicating success.
        """
        return self.update_goal_status(goal_id, GoalStatus.ACTIVE)

    def complete_goal(self, goal_id: str) -> Result:
        """Mark a goal as completed.

        Args:
            goal_id: Goal identifier.

        Returns:
            Result indicating success.
        """
        r = self.update_goal_status(goal_id, GoalStatus.COMPLETED)
        if r.ok and self._active_goal == goal_id:
            self._active_goal = None
            self._persist_goal_state()
        return r

    def fail_goal(self, goal_id: str, reason: str, terminal: bool = False) -> Result:
        """Mark a goal as failed.

        Args:
            goal_id: Goal identifier.
            reason: Failure reason.
            terminal: When True, use the ``ovolve_failed_final`` terminal state
                (a closed failure is not auto-retried).

        Returns:
            Result indicating success.
        """
        r = self.storage.get_goal(goal_id)
        if r is None:
            return Result.failure(f"Goal not found: {goal_id}")
        status = GoalStatus.FAILED_FINAL if terminal else GoalStatus.FAILED
        self.storage.save_goal(
            goal_id, r.get("description", ""), status,
            r.get("iteration", 0), r.get("session_id", ""),
            json.dumps({"failed": True, "closed": terminal, "reason": reason}),
        )
        if self._active_goal == goal_id:
            self._active_goal = None
            self._persist_goal_state()
        return Result.success(f"Goal failed: {reason}")

    def delete_goal(self, goal_id: str) -> Result:
        """Delete a goal (mark as cancelled).

        Args:
            goal_id: Goal identifier.

        Returns:
            Result indicating success.
        """
        r = self.storage.get_goal(goal_id)
        if r is None:
            return Result.failure(f"Goal not found: {goal_id}")
        self.storage.save_goal(
            goal_id, r.get("description", ""), GoalStatus.CANCELLED,
            r.get("iteration", 0), r.get("session_id", ""), "",
        )
        if self._active_goal == goal_id:
            self._active_goal = None
            self._persist_goal_state()
        return Result.success(f"Goal cancelled: {goal_id}")

    async def verify_completion(self, goal_id: str, evidence: str = "", workspace: str = "") -> dict:
        """Verify if a goal is truly complete, enforcing Machine Verification Gate (Phase 3 / ProgramBench).

        Rule (Anti-Early-Quit / Fail-Closed):
        1. First, check AcceptanceContract via machine verification (check_completion).
           If there are unmet criteria (failing tests, missing artifacts, path violations):
           the goal FAILS verification immediately. The LLM is NOT allowed to claim success.
        2. Only when machine verification is 100% green, proceed to LLM semantic review.

        Args:
            goal_id: Goal identifier.
            evidence: Optional evidence string (e.g., tool output, file contents).
            workspace: Optional workspace directory path.

        Returns:
            Dict with keys: {passed: bool, reason: str, suggestions: list}.
        """
        span = self.telemetry.start_span("goal_verify", goal_id=goal_id)
        try:
            r = self.storage.get_goal(goal_id)
            if r is None:
                self.telemetry.end_span(span, error="not_found")
                return {"passed": False, "reason": "Goal not found", "suggestions": []}

            description = r.get("description", "")
            iterations = r.get("iteration", 0)

            # ── 1. 机器硬门禁校验 (Machine Verification Gate) ──
            from acceptance_contract import get_goal_contract, check_completion
            contract = get_goal_contract(self.storage, goal_id)
            if contract:
                ws = workspace or self._workspace or "."
                mach_ok, unmet, results = check_completion(contract, ws)
                if not mach_ok:
                    reason = f"Machine verification gate failed: {'; '.join(unmet[:3])}"
                    result = {
                        "passed": False,
                        "reason": reason,
                        "completed": [],
                        "unmet": unmet,
                        "validator_results": results,
                        "suggestions": [f"Fix failing verification item: {u}" for u in unmet[:5]],
                    }
                    self.storage.save_goal(
                        goal_id, description, r.get("status", "active"),
                        iterations, r.get("session_id", ""),
                        json.dumps(result, ensure_ascii=False),
                    )
                    self.telemetry.end_span(span, passed=False, error=reason)
                    return result

            # Prefer the structured brief when one is attached — the LLM should
            # be checking the actual acceptance criteria, not paraphrasing a
            # description into a fuzzy pass/fail.
            brief = self.get_brief(goal_id)
            brief_block = ""
            if brief is not None:
                brief_block = "\n" + brief.system_context()

            if self._llm:
                try:
                    plan_block = self._plan_block(goal_id)
                    prompt_data = {
                        "task": "goal_verification",
                        "instruction": (
                            "You are verifying whether a long-running goal is complete.\n"
                            f"GOAL: {description}"
                            f"{brief_block}\n"
                            f"{plan_block}"
                            f"ITERATIONS SO FAR: {iterations}\n"
                            f"EVIDENCE FROM THE LAST ITERATION:\n{evidence}\n\n"
                            "Decide whether every acceptance criterion is fully met. "
                            "Be strict: partial progress is NOT completion.\n"
                            'Respond with ONLY a JSON object, no prose, no code fences:\n'
                            '{"passed": true|false, "reason": "<one sentence>", '
                            '"completed": [<1-based numbers of the sub-tasks above that are '
                            'now fully done, [] if none>], '
                            '"suggestions": ["<next concrete step>", "..."]}'
                        ),
                        "goal": description,
                        "brief": brief.to_dict() if brief else None,
                        "iterations": iterations,
                        "evidence": evidence,
                    }
                    if asyncio.iscoroutinefunction(self._llm):
                        result = await self._llm(prompt_data)
                    else:
                        result = self._llm(prompt_data)
                except Exception:
                    result = None

                result = self._coerce_verification(result)
                if result is not None:
                    self.storage.save_goal(
                        goal_id, description, r.get("status", "active"),
                        iterations, r.get("session_id", ""),
                        json.dumps(result),
                    )
                    self.telemetry.end_span(span, passed=result.get("passed", False))
                    return result


            # Fallback: heuristic verification (no LLM available).
            # P0 fix (audit §2): the previous logic was inverted —
            #   passed = iterations > 0 and not evidence
            # which declared success when there was NO evidence and failed when
            # evidence WAS supplied. Correct semantics: we can only claim
            # completion when there IS evidence and it shows no signs of
            # incomplete/failed work.
            incomplete_markers = (
                "todo", "not yet", "incomplete", "failed", "error",
                "pending", "还没", "未完成", "失败", "待办",
            )
            ev = (evidence or "").lower()
            has_evidence = bool(ev.strip())
            looks_incomplete = any(m in ev for m in incomplete_markers)
            passed = has_evidence and not looks_incomplete
            if passed:
                reason = "Heuristic: evidence present with no incomplete markers"
            elif not has_evidence:
                reason = "Heuristic: no evidence supplied, cannot confirm completion"
            else:
                reason = "Heuristic: evidence contains incomplete/error markers"
            result = {
                "passed": passed,
                "reason": reason,
                "suggestions": [],
                # No plan judgement without an LLM: the heuristic only looks for
                # failure markers in text and has no idea which sub-task moved.
                "completed": [],
            }
            self.storage.save_goal(
                goal_id, description, r.get("status", "active"),
                iterations, r.get("session_id", ""),
                json.dumps(result),
            )
            self.telemetry.end_span(span, passed=passed)
            return result
        except Exception as e:
            self.telemetry.end_span(span, error=str(e))
            return {"passed": False, "reason": str(e), "suggestions": []}

    @staticmethod
    def _plan_block(goal_id: str) -> str:
        """The goal's sub-task list, numbered, for the verifier prompt.

        Numbered because the verifier answers with ``completed: [2, 3]`` and the
        scheduler flips exactly those items — without the numbering there is
        nothing for those indices to refer to. Returns "" when the goal has no
        plan, so the prompt simply omits the section.
        """
        try:
            import goal_plan
            items = goal_plan.load_plan(goal_id)
        except Exception:
            return ""
        if not items:
            return ""
        lines = ["SUB-TASKS (1-based, current status in brackets):"]
        for i, item in enumerate(items, start=1):
            lines.append(f"  {i}. [{item['status']}] {item['title']}")
        return "\n".join(lines) + "\n"

    @staticmethod
    def _coerce_verification(raw: Any) -> Optional[dict]:
        """Normalize an LLM verification reply into ``{passed, reason, suggestions}``.

        Reasoning models often wrap JSON in prose or code fences, and some
        return a bare string. Anything unparseable yields None so the caller
        falls through to the heuristic instead of trusting a malformed verdict.

        Args:
            raw: Whatever the llm callback returned.

        Returns:
            A normalized dict, or None when no verdict could be extracted.
        """
        data: Any = raw
        if isinstance(raw, str):
            text = raw.strip()
            text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
            text = re.sub(r"\n?```$", "", text).strip()
            try:
                data = json.loads(text)
            except (json.JSONDecodeError, ValueError):
                # Last resort: find the first {...} block in the prose.
                match = re.search(r"\{.*\}", text, re.DOTALL)
                if not match:
                    return None
                try:
                    data = json.loads(match.group(0))
                except (json.JSONDecodeError, ValueError):
                    return None
        if not isinstance(data, dict) or "passed" not in data:
            return None
        passed = data.get("passed")
        if isinstance(passed, str):
            passed = passed.strip().lower() in ("true", "yes", "1")
        suggestions = data.get("suggestions") or []
        if isinstance(suggestions, str):
            suggestions = [suggestions]
        # Which sub-tasks the verifier says are now done. Kept as strings because
        # goal_plan matches either a 1-based position or an item id, and a model
        # answers with whichever it feels like.
        completed = data.get("completed") or []
        if isinstance(completed, (str, int)):
            completed = [completed]
        if not isinstance(completed, (list, tuple)):
            completed = []
        return {
            "passed": bool(passed),
            "reason": str(data.get("reason", "")),
            "suggestions": [str(s) for s in suggestions][:10],
            "completed": [str(c) for c in completed][:50],
        }

    async def continue_goal(self, goal_id: str, max_iterations: int = 10) -> Result:
        """Auto-continue a goal that failed verification.

        Constructs a system reminder and injects it for the router to pick up.
        The router will auto-resume without waiting for user input.

        Args:
            goal_id: Goal identifier.
            max_iterations: Maximum continuation attempts (default 10).

        Returns:
            Result with the system reminder string on success,
            or failure if max iterations exceeded.
        """
        span = self.telemetry.start_span("goal_continue", goal_id=goal_id)
        try:
            r = self.storage.get_goal(goal_id)
            if r is None:
                self.telemetry.end_span(span, error="not_found")
                return Result.failure(f"Goal not found: {goal_id}")

            if r.get("status") not in ACTIVE_STATES:
                self.telemetry.end_span(span, error="not_active")
                return Result.failure(f"Goal is not active: {r.get('status')}")

            continuation_count = r.get("iteration", 0)
            if continuation_count >= max_iterations:
                self.telemetry.end_span(span, error="max_iterations")
                return Result.failure(
                    f"Max iterations ({max_iterations}) exceeded for goal: {goal_id}"
                )

            description = r.get("description", "")
            ver_raw = r.get("verification_result", "")
            try:
                ver = json.loads(ver_raw) if ver_raw else {}
            except (json.JSONDecodeError, TypeError):
                ver = {}

            reason = ver.get("reason", "unknown")
            suggestions = ver.get("suggestions", [])

            reminder_parts = [
                f'Goal "{description}" is not yet complete.',
                f"Reason: {reason}",
            ]
            if suggestions:
                reminder_parts.append("Suggestions:")
                for s in suggestions:
                    reminder_parts.append(f"  - {s}")
            # What is still open, from the goal's own plan. This is the part that
            # survives a restart: without it a resumed goal was handed its
            # original description again and started over, redoing finished work.
            try:
                import goal_plan
                remaining = goal_plan.render_unfinished(goal_plan.load_plan(goal_id))
            except Exception:
                remaining = ""
            if remaining:
                reminder_parts.append(remaining)
            # Phase 2: what already LANDED, not just what remains. Without this
            # a resumed goal redid completed side effects — the exact failure
            # the durable-recovery acceptance forbids. Empty when nothing
            # completed, so fresh goals get an unchanged prompt.
            try:
                from recovery import render_completed_side_effects
                landed = render_completed_side_effects(goal_id, self.storage)
                if landed:
                    reminder_parts.append(landed)
            except Exception:
                # 读不到已落地清单,续跑就无法回答"哪些操作不该重做"。以前这里
                # 静默 pass,模型完全不知道自己是在信息缺失的情况下继续——它会
                # 照着计划重做一遍。说出来,让它先核对。
                reminder_parts.append(
                    "[warning] 已落地副作用清单读取失败：本次续跑无法确认哪些操作"
                    "已经生效，动手前请先核对当前状态。")
            # ...and what nobody can vouch for. Interrupted mid-flight calls are
            # the ones a resumed run is most likely to repeat, because "not
            # completed" reads as "never happened". Kept as a separate block
            # from the landed list: the instruction is "verify", not "skip".
            try:
                from recovery import render_unknown_side_effects
                unresolved = render_unknown_side_effects(goal_id, self.storage)
                if unresolved:
                    reminder_parts.append(unresolved)
            except Exception:
                reminder_parts.append(
                    "[warning] 未结算副作用清单读取失败：可能有操作已派发但结果未知，"
                    "动手前请先核对当前状态。")
            reminder_parts.append(
                f"Please continue working on this goal. "
                f"(Continuation {continuation_count + 1}/{max_iterations})"
            )

            system_reminder = "\n".join(reminder_parts)
            # NOTE: deliberately does NOT call add_iteration. The scheduler loop
            # (goal_scheduler._run_worker) already increments the counter exactly
            # once per round via its own add_iteration call. Incrementing again
            # here made every round count as two, halving the effective
            # max_iterations budget and surfacing the failure as "max iterations
            # exceeded" — which read like the model wasn't converging when the
            # real cause was double-counting. continue_goal only *reads* the
            # counter (above) to decide whether the budget is spent.


            self.telemetry.end_span(span, continuation=continuation_count + 1)
            return Result.success({
                "system_reminder": system_reminder,
                "iteration": continuation_count + 1,
                "max_iterations": max_iterations,
            })
        except Exception as e:
            self.telemetry.end_span(span, error=str(e))
            return Result.failure(f"Continue goal failed: {e}")

    def get_progress_summary(self, goal_id: str) -> Result:
        """Get a summary of goal progress.

        Args:
            goal_id: Goal identifier.

        Returns:
            Result containing progress summary dict.
        """
        r = self.storage.get_goal(goal_id)
        if r is None:
            return Result.failure(f"Goal not found: {goal_id}")
        iterations = r.get("iteration", 0)
        return Result.success({
            "goal_id": goal_id,
            "description": r.get("description"),
            "status": r.get("status"),
            "total_iterations": iterations,
            "progress": f"{iterations} iterations",
            "verification_result": r.get("verification_result", ""),
        })


_manager: Optional[GoalManager] = None


def get_goal_manager(llm_callback: Optional[Callable] = None) -> GoalManager:
    """Get the global GoalManager singleton.

    Args:
        llm_callback: Optional async callback for LLM-based verification.

    Returns:
        GoalManager instance.
    """
    global _manager
    if _manager is None:
        _manager = GoalManager(llm_callback=llm_callback)
    return _manager
