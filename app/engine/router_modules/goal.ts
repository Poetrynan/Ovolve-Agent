/**
 * router_modules/goal.ts - Goal continuation and execution mixin.
 *
 * Ported from `app/backend/router_modules/goal.py` (79 lines, wave-8, unit 182).
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import { Result } from "../result.js";

export class RouterGoalMixin {
  goals: any;
  workspace: string | null = null;
  bus: any;
  session_id: string = "";

  async handle(prompt: string): Promise<Result> {
    throw new Error("handle must be implemented by host router");
  }

  /**
   * Run a long-horizon goal to completion with automatic continuation.
   *
   * The loop drives itself: each iteration handles the current continuation
   * prompt, then asks goal_manager to verify completion. When verification
   * fails, the returned system reminder becomes the next turn's prompt —
   * no user input required. `max_iterations` bounds the loop.
   */
  async run_goal(description: string, max_iterations = 10): Promise<Result> {
    this.goals.set_workspace(this.workspace || ".");
    const goal = this.goals.create_goal(description);
    const transcript: string[] = [];
    let prompt = description;

    for (let i = 0; i < max_iterations; i++) {
      const turn = await this.handle(prompt);
      const evidence = turn.ok ? turn.value : `[failed] ${turn.error}`;
      transcript.push(String(evidence));
      this.goals.add_iteration(goal.id, String(evidence));

      // verify_completion returns a plain dict {passed, reason, suggestions}
      // Enforces Machine Verification Gate (Anti-Early-Quit)
      const verdict = await this.goals.verify_completion(
        goal.id,
        String(evidence),
        this.workspace || "."
      );
      if (verdict && verdict["passed"]) {
        this.goals.complete_goal(goal.id);
        await this.bus.emit("goal_state_change", {
          goal_id: goal.id,
          status: "completed",
          session_id: this.session_id,
        });
        return Result.success({
          goal_id: goal.id,
          status: "completed",
          iterations: transcript.length,
          reason: verdict["reason"] || "",
          transcript,
        });
      }

      const cont = await this.goals.continue_goal(goal.id, max_iterations);
      if (!cont.ok) {
        this.goals.fail_goal(goal.id, cont.error, true);
        await this.bus.emit("goal_state_change", {
          goal_id: goal.id,
          status: "ovolve_failed_final",
          reason: cont.error,
          session_id: this.session_id,
        });
        return Result.failure(
          `Goal stopped after ${transcript.length} iterations: ${cont.error}`,
          { goal_id: goal.id, transcript }
        );
      }
      prompt = cont.value["system_reminder"];
    }

    this.goals.fail_goal(goal.id, "max_iterations exhausted", true);
    await this.bus.emit("goal_state_change", {
      goal_id: goal.id,
      status: "ovolve_failed_final",
      reason: "max_iterations exhausted",
      session_id: this.session_id,
    });
    return Result.failure(
      `Goal did not converge within ${max_iterations} iterations`,
      { goal_id: goal.id, transcript }
    );
  }
}
