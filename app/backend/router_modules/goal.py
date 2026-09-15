"""router_modules/goal.py - Goal continuation and execution mixin."""
from __future__ import annotations

from typing import Any
from result import Result


class RouterGoalMixin:
    """Mixin providing long-horizon goal auto-continuation for Router."""

    async def run_goal(self, description: str, max_iterations: int = 10) -> Result:
        """Run a long-horizon goal to completion with automatic continuation.

        The loop drives itself: each iteration handles the current continuation
        prompt, then asks goal_manager to verify completion. When verification
        fails, the returned system reminder becomes the next turn's prompt —
        no user input required. ``max_iterations`` bounds the loop.

        Args:
            description: The goal in the user's own words.
            max_iterations: Hard ceiling on continuation rounds.

        Returns:
            Result with a summary dict on success, or the failure reason.
        """
        self.goals.set_workspace(self.workspace or ".")
        goal = self.goals.create_goal(description)
        transcript: list[str] = []
        prompt = description

        for _ in range(max_iterations):
            turn = await self.handle(prompt)
            evidence = turn.value if turn.ok else f"[failed] {turn.error}"
            transcript.append(str(evidence))
            self.goals.add_iteration(goal.id, str(evidence))

            # verify_completion returns a plain dict {passed, reason, suggestions}
            # Enforces Machine Verification Gate (Anti-Early-Quit)
            verdict = await self.goals.verify_completion(
                goal.id, evidence=str(evidence), workspace=self.workspace or "."
            )
            if verdict.get("passed"):
                self.goals.complete_goal(goal.id)
                await self.bus.emit("goal_state_change", {
                    "goal_id": goal.id, "status": "completed",
                    "session_id": self.session_id,
                })
                return Result.success({
                    "goal_id": goal.id,
                    "status": "completed",
                    "iterations": len(transcript),
                    "reason": verdict.get("reason", ""),
                    "transcript": transcript,
                })

            cont = await self.goals.continue_goal(goal.id, max_iterations=max_iterations)
            if not cont.ok:
                self.goals.fail_goal(goal.id, cont.error, terminal=True)
                await self.bus.emit("goal_state_change", {
                    "goal_id": goal.id, "status": "ovolve_failed_final", "reason": cont.error,
                    "session_id": self.session_id,
                })
                return Result.failure(
                    f"Goal stopped after {len(transcript)} iterations: {cont.error}",
                    goal_id=goal.id, transcript=transcript,
                )
            prompt = cont.value["system_reminder"]

        self.goals.fail_goal(goal.id, "max_iterations exhausted", terminal=True)
        await self.bus.emit("goal_state_change", {
            "goal_id": goal.id, "status": "ovolve_failed_final",
            "reason": "max_iterations exhausted",
            "session_id": self.session_id,
        })
        return Result.failure(
            f"Goal did not converge within {max_iterations} iterations",
            goal_id=goal.id, transcript=transcript,
        )
