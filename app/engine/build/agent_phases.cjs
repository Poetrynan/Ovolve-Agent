"use strict";
/**
 * agent_phases.ts 鈥?Named lifecycle phases for an agent turn.
 *
 * Ported from `app/backend/agent_phases.py` (129 lines).
 *
 * RULEBOOK CITATIONS:
 * - 搂2 TurnPhase enum mapped to string union (str Enum 鈫?string literal union).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PHASE_ORDER = exports.TurnPhase = void 0;
exports.emit_phase = emit_phase;
var TurnPhase;
(function (TurnPhase) {
    /** Router.handle() has been called. Nothing has been done yet. */
    TurnPhase["TURN_ENTERED"] = "turn_entered";
    /** The permission level for this turn has been resolved. */
    TurnPhase["PERMISSION_RESOLVED"] = "permission_resolved";
    /** Sandbox root, path_guard and cwd for tools are locked in. */
    TurnPhase["WORKSPACE_READY"] = "workspace_ready";
    /** Assembling the message list: history + memory + rules + tool preamble. */
    TurnPhase["CONTEXT_ENGINE"] = "context_engine";
    /** The full prompt is built. The next thing is the model call. */
    TurnPhase["CONTEXT_ASSEMBLED"] = "context_assembled";
    /** HTTP request to the LLM provider is in flight. */
    TurnPhase["MODEL_CALL_STARTED"] = "model_call_started";
    /** First delta from the model arrived. */
    TurnPhase["ASSISTANT_OUTPUT_STARTED"] = "assistant_output_started";
    /** A tool call is about to run. */
    TurnPhase["TOOL_EXECUTION_STARTED"] = "tool_execution_started";
    /** Tool result is back (success or failure). */
    TurnPhase["TOOL_EXECUTION_FINISHED"] = "tool_execution_finished";
    /** Between two model steps in a multi-step agent loop. */
    TurnPhase["STEP_BOUNDARY"] = "step_boundary";
    /** Model produced its final reply text for this turn. */
    TurnPhase["ASSISTANT_REPLY_FINALIZED"] = "assistant_reply_finalized";
    /** Everything after the reply: memory extraction, evolution, snapshot. */
    TurnPhase["POST_TURN_HOOKS"] = "post_turn_hooks";
    /** End of the turn. */
    TurnPhase["TURN_COMPLETED"] = "turn_completed";
})(TurnPhase || (exports.TurnPhase = TurnPhase = {}));
exports.PHASE_ORDER = Object.values(TurnPhase);
async function emit_phase(bus, phase, opts) {
    if (!bus) {
        return;
    }
    const payload = {
        phase: phase,
        session_id: opts.session_id,
        turn_id: opts.turn_id,
        ts: Date.now() / 1000,
    };
    if (opts.extra) {
        Object.assign(payload, opts.extra);
    }
    try {
        await bus.emit("agent_phase", payload);
    }
    catch (exc) {
        // Observability must never crash the run (RULEBOOK 搂2 broad swallow).
        console.warn(`[agent_phases] emit failed for ${phase}: ${exc}`);
    }
}
// PORT STATUS: confidence=high todos=[0]
