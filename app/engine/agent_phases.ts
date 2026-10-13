/**
 * agent_phases.ts — Named lifecycle phases for an agent turn.
 *
 * Ported from `app/backend/agent_phases.py` (129 lines).
 *
 * RULEBOOK CITATIONS:
 * - §2 TurnPhase enum mapped to string union (str Enum → string literal union).
 */

export enum TurnPhase {
    /** Router.handle() has been called. Nothing has been done yet. */
    TURN_ENTERED = "turn_entered",
    /** The permission level for this turn has been resolved. */
    PERMISSION_RESOLVED = "permission_resolved",
    /** Sandbox root, path_guard and cwd for tools are locked in. */
    WORKSPACE_READY = "workspace_ready",
    /** Assembling the message list: history + memory + rules + tool preamble. */
    CONTEXT_ENGINE = "context_engine",
    /** The full prompt is built. The next thing is the model call. */
    CONTEXT_ASSEMBLED = "context_assembled",
    /** HTTP request to the LLM provider is in flight. */
    MODEL_CALL_STARTED = "model_call_started",
    /** First delta from the model arrived. */
    ASSISTANT_OUTPUT_STARTED = "assistant_output_started",
    /** A tool call is about to run. */
    TOOL_EXECUTION_STARTED = "tool_execution_started",
    /** Tool result is back (success or failure). */
    TOOL_EXECUTION_FINISHED = "tool_execution_finished",
    /** Between two model steps in a multi-step agent loop. */
    STEP_BOUNDARY = "step_boundary",
    /** Model produced its final reply text for this turn. */
    ASSISTANT_REPLY_FINALIZED = "assistant_reply_finalized",
    /** Everything after the reply: memory extraction, evolution, snapshot. */
    POST_TURN_HOOKS = "post_turn_hooks",
    /** End of the turn. */
    TURN_COMPLETED = "turn_completed",
}

export const PHASE_ORDER: readonly TurnPhase[] = Object.values(TurnPhase);

export interface PhasePayload {
    phase: string;
    session_id: string;
    turn_id?: string;
    ts: number;
    [key: string]: unknown;
}

export async function emit_phase(
    bus: { emit?: (event: string, payload: PhasePayload) => Promise<void> } | null | undefined,
    phase: TurnPhase,
    opts: {
        session_id: string;
        turn_id?: string;
        extra?: Record<string, unknown>;
    },
): Promise<void> {
    if (!bus) {
        return;
    }
    const payload: PhasePayload = {
        phase: phase as string,
        session_id: opts.session_id,
        turn_id: opts.turn_id,
        ts: Date.now() / 1000,
    };
    if (opts.extra) {
        Object.assign(payload, opts.extra);
    }
    try {
        await bus.emit!("agent_phase", payload);
    } catch (exc) {
        // Observability must never crash the run (RULEBOOK §2 broad swallow).
        console.warn(`[agent_phases] emit failed for ${phase}: ${exc}`);
    }
}

// PORT STATUS: confidence=high todos=[0]
