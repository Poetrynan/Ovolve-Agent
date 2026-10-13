/**
 * router_trace.ts — Mirror the Router's bus traffic into the EventStore.
 *
 * Ported from `app/backend/router_trace.py` (232 lines).
 *
 * Why this exists
 * ---------------
 * The Router already narrates everything it does on its in-memory event bus
 * (`agent_phase` crossings, `pre_tool_use` gates, `tool_result` settles),
 * but that narration evaporated with the process: the EventStore never saw a
 * single turn. This bridge is the missing pipe — it subscribes to the bus and
 * appends the corresponding EventType rows through the canonical
 * TraceGateway, so a turn becomes rebuildable from the
 * ledger (Phase 1 acceptance) without the Router itself learning about
 * persistence.
 *
 * Mapping policy: only phases with a clean counterpart in the existing 35-event
 * vocabulary are recorded — no new event types, no renames. Tool lifecycle is
 * taken from `pre_tool_use` / `tool_result` (richer: real `call_id`,
 * status, error), NOT from the `tool_execution_*` phases, which would double-
 * record the same call.
 *
 * Failure contract: everything here is OBSERVATIONAL. A broken trace mirror
 * must never break the turn it is tracing — the gateway logs the loss loudly
 * and the agent keeps running. (Phase 2 turns the critical subset — approvals,
 * side effects — fail-closed where the Router can act on it.)
 *
 * RULEBOOK CITATIONS:
 * - §1 node:crypto randomUUID for uuid4().hex[:12]
 * - §2 Python logging -> console.error (observational failure logging)
 * - §2 Preserved exact idempotency keys, payloads, and correlation absorption
 *
 * PORT STATUS: confidence=high todos=0
 */

import { randomUUID } from "node:crypto";
import { EventType, type EventTypeValue } from "./event_types.js";
import { TraceGateway, OBSERVATIONAL } from "./trace_gateway.js";
import type { EventStore } from "./event_store.js";

export const _PHASE_TO_EVENT: Record<string, EventTypeValue> = {
    turn_entered: EventType.AGENT_TURN_STARTED,
    model_call_started: EventType.LLM_REQUEST_SENT,
    turn_completed: EventType.AGENT_TURN_COMPLETED,
};

function generateShortId(): string {
    return randomUUID().replace(/-/g, "").slice(0, 12);
}

export class RouterTraceBridge {
    /**
     * One bridge per Router (per session). It filters bus traffic by
     * `session_id`, so several routers sharing a process-wide bus each record
     * only their own session's events.
     */
    _bus: any;
    _session_id: string;
    _gateway: TraceGateway;
    _current_turn: string | null;
    _current_goal: string;
    _current_run: string;

    constructor(bus: any, session_id: string, store: EventStore | null = null) {
        this._bus = bus;
        this._session_id = session_id;
        this._gateway = new TraceGateway(store);
        this._current_turn = null;
        this._current_goal = "";
        this._current_run = "";

        // Bind handler references so on/off use the exact same function instances
        this._on_phase = this._on_phase.bind(this);
        this._on_pre_tool_use = this._on_pre_tool_use.bind(this);
        this._on_tool_result = this._on_tool_result.bind(this);
    }

    get bus(): any {
        return this._bus;
    }

    get sessionId(): string {
        return this._session_id;
    }

    get gateway(): TraceGateway {
        return this._gateway;
    }

    get currentTurn(): string | null {
        return this._current_turn;
    }

    get currentGoal(): string {
        return this._current_goal;
    }

    get currentRun(): string {
        return this._current_run;
    }

    // ── wiring ──────────────────────────────────────────────────────────────

    mount(): void {
        /**
         * Subscribe. Low priority so guards and risk control run first — by
         * the time the bridge sees `pre_tool_use`, `event.action` already
         * reflects the gate's verdict and can be recorded with the request.
         */
        this._bus.on("agent_phase", this._on_phase, -100);
        this._bus.on("pre_tool_use", this._on_pre_tool_use, -100);
        this._bus.on("tool_result", this._on_tool_result, -100);
    }

    unmount(): void {
        this._bus.off("agent_phase", this._on_phase);
        this._bus.off("pre_tool_use", this._on_pre_tool_use);
        this._bus.off("tool_result", this._on_tool_result);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    static _terminal_event_type(phase: string, p?: Record<string, any> | null): EventTypeValue | null {
        /** Which EventType a phase crossing maps to (null = don't record). */
        if (phase === "turn_completed" && p?.cancelled) {
            return EventType.AGENT_TURN_CANCELLED;
        }
        return _PHASE_TO_EVENT[phase] ?? null;
    }

    static terminalEventType(phase: string, p?: Record<string, any> | null): EventTypeValue | null {
        return RouterTraceBridge._terminal_event_type(phase, p);
    }

    _absorb_correlation(p: Record<string, any>): void {
        /**
         * Learn goal/run attribution from whichever frame happens to carry it.
         *
         * Read from the top level first (the phase emit puts them there) then from
         * the nested `context` (what the tool frames pass through verbatim).
         * Only non-empty values overwrite: a frame that omits the keys must not
         * erase what an earlier frame in the same turn established.
         */
        const ctx = (p && typeof p.context === "object" && p.context !== null && !Array.isArray(p.context))
            ? (p.context as Record<string, any>)
            : {};
        const rawGoal = p?.goal_id || ctx?.goal_id || "";
        const rawRun = p?.run_id || ctx?.run_id || "";
        const goal = rawGoal ? String(rawGoal) : "";
        const run = rawRun ? String(rawRun) : "";
        if (goal) {
            this._current_goal = goal;
        }
        if (run) {
            this._current_run = run;
        }
    }

    _append(opts: {
        event_type: any;
        payload: Record<string, any>;
        key: string;
        turn_id?: string | null;
        step_id?: string | null;
        tool_call_id?: string | null;
        goal_id?: string | null;
        run_id?: string | null;
        [k: string]: any;
    }): void {
        const goal_id = opts.goal_id !== undefined ? opts.goal_id : (this._current_goal || null);
        const run_id = opts.run_id !== undefined ? opts.run_id : (this._current_run || null);
        this._gateway.append({
            session_id: this._session_id,
            event_type: opts.event_type,
            payload: opts.payload,
            importance: OBSERVATIONAL,
            idempotency_key: opts.key,
            actor: "assistant",
            turn_id: opts.turn_id ?? null,
            step_id: opts.step_id ?? null,
            tool_call_id: opts.tool_call_id ?? null,
            goal_id,
            run_id,
            causation_id: opts.causation_id ?? null,
            branch_id: opts.branch_id ?? null,
            parent_event_id: opts.parent_event_id ?? null,
            visibility: opts.visibility ?? "audit",
        });
    }

    // ── handlers (sync: the store is sync, and the bus supports both) ───────

    _on_phase(event: any): void {
        try {
            const p = event?.payload || {};
            if (p.session_id !== this._session_id) {
                return;
            }
            const phase = p.phase;
            if (RouterTraceBridge._terminal_event_type(phase, p) === null) {
                return;
            }

            if (phase === "turn_entered") {
                // A new turn owns its own attribution. Resetting first is what
                // keeps a goal turn's ids from bleeding into the next, ordinary
                // chat turn on the same session.
                this._current_goal = "";
                this._current_run = "";
            }
            this._absorb_correlation(p);

            let turn_id = p.turn_id || this._current_turn;
            if (phase === "turn_entered") {
                turn_id = p.turn_id || generateShortId();
                this._current_turn = turn_id;
            }
            if (phase === "turn_completed" && turn_id === null) {
                // A completion without a recorded start (bridge mounted
                // mid-turn): still record it, just without correlation.
                turn_id = null;
            }

            // Cancel honesty: a turn the user stopped is a DIFFERENT terminal
            // fact from a finished one. The Router stamps `cancelled` on the
            // TURN_COMPLETED phase; recording it as AGENT_TURN_CANCELLED keeps
            // a replayed ledger from showing interrupted work as successful.
            const etype = RouterTraceBridge._terminal_event_type(phase, p);

            const payload: Record<string, any> = { phase };
            if ("step" in p) {
                payload.step = p.step;
            }
            if ("tool" in p) {
                payload.tool = p.tool;
            }
            if ("ok" in p) {
                payload.ok = Boolean(p.ok);
            }
            if (p?.cancelled) {
                payload.cancelled = true;
            }

            const turnStr = turn_id != null ? String(turn_id) : "None";
            let key = `phase:${this._session_id}:${turnStr}:${phase}`;
            if ("step" in p) {
                key += `:s${p.step}`;
            }

            this._append({
                event_type: etype,
                payload,
                key,
                turn_id,
                step_id: "step" in p ? String(p.step) : null,
            });

            if (phase === "turn_completed") {
                this._current_turn = null;
                this._current_goal = "";
                this._current_run = "";
            }
        } catch (exc) {
            console.error("trace bridge failed on agent_phase — turn continues untraced", exc);
        }
    }

    _on_pre_tool_use(event: any): void {
        try {
            const p = event?.payload || {};
            if (p.session_id !== this._session_id) {
                return;
            }
            const call_id = p.call_id || generateShortId();
            this._absorb_correlation(p);

            const actionVal = typeof event?.action?.value === "string"
                ? event.action.value
                : typeof event?.action === "string"
                    ? event.action
                    : String(event?.action ?? "");

            const blockReason = event?.block_reason ?? event?.blockReason ?? "";

            this._append({
                event_type: EventType.TOOL_CALL_REQUESTED,
                payload: {
                    tool: p.tool_name ?? "",
                    call_id,
                    args: p.args ?? {},
                    action: actionVal,
                    block_reason: blockReason ? String(blockReason) : "",
                },
                key: `tool:${this._session_id}:${call_id}:requested`,
                turn_id: this._current_turn,
                tool_call_id: call_id,
            });
        } catch (exc) {
            console.error("trace bridge failed on pre_tool_use — turn continues untraced", exc);
        }
    }

    _on_tool_result(event: any): void {
        try {
            const p = event?.payload || {};
            if (p.session_id !== this._session_id) {
                return;
            }
            const call_id = p.call_id || generateShortId();
            const result = p.result || {};
            this._absorb_correlation(p);

            const ok = Boolean(result.ok);
            const status = String(p.status || (ok ? "completed" : "failed"));
            let etype: EventTypeValue;
            if (status === "cancelled") {
                etype = EventType.TOOL_EXECUTION_CANCELLED;
            } else if (ok) {
                etype = EventType.TOOL_EXECUTION_COMPLETED;
            } else {
                etype = EventType.TOOL_EXECUTION_FAILED;
            }

            const error = result.error;
            const errStr = error ? String(error).slice(0, 200) : "";

            this._append({
                event_type: etype,
                payload: {
                    tool: p.tool_name ?? "",
                    call_id,
                    status,
                    error: errStr,
                },
                key: `tool:${this._session_id}:${call_id}:settled`,
                turn_id: this._current_turn,
                tool_call_id: call_id,
            });
        } catch (exc) {
            console.error("trace bridge failed on tool_result — turn continues untraced", exc);
        }
    }
}
