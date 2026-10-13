"use strict";
/**
 * projection_engine.ts 鈥?High-Fidelity State Projection & Time-Travel Engine.
 *
 * Ported from `app/backend/projection_engine.py` (265 lines).
 *
 * RULEBOOK CITATIONS:
 * - 搂2 dataclass 鈫?interface + class.
 *
 * NOTES:
 * - ProjectedSessionState and SessionProjector.apply_event are fully ported (pure).
 * - ProjectionEngine depends on EventStore (not yet translated) 鈥?stubbed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectionEngine = exports.SessionProjector = exports.ProjectedSessionState = void 0;
exports.get_projection_engine = get_projection_engine;
const event_types_js_1 = require("./event_types.cjs");
class ProjectedSessionState {
    session_id;
    title;
    status;
    created_at;
    updated_at;
    current_turn;
    last_seq;
    goal_state;
    messages;
    active_tools;
    metadata;
    constructor(opts) {
        this.session_id = opts.session_id;
        this.title = opts.title ?? "New Session";
        this.status = opts.status ?? "idle";
        this.created_at = opts.created_at ?? 0;
        this.updated_at = opts.updated_at ?? 0;
        this.current_turn = opts.current_turn ?? 0;
        this.last_seq = opts.last_seq ?? 0;
        this.goal_state = opts.goal_state ?? null;
        this.messages = opts.messages ?? [];
        this.active_tools = opts.active_tools ?? {};
        this.metadata = opts.metadata ?? {};
    }
    toDict() {
        return {
            session_id: this.session_id,
            title: this.title,
            status: this.status,
            created_at: this.created_at,
            updated_at: this.updated_at,
            current_turn: this.current_turn,
            last_seq: this.last_seq,
            goal_state: this.goal_state,
            messages: this.messages,
            active_tools: this.active_tools,
            metadata: this.metadata,
        };
    }
    static fromDict(data) {
        return new ProjectedSessionState({
            session_id: data.session_id,
            title: data.title,
            status: data.status,
            created_at: data.created_at,
            updated_at: data.updated_at,
            current_turn: data.current_turn,
            last_seq: data.last_seq,
            goal_state: data.goal_state ?? null,
            messages: data.messages ?? [],
            active_tools: data.active_tools ?? {},
            metadata: data.metadata ?? {},
        });
    }
}
exports.ProjectedSessionState = ProjectedSessionState;
// Pure deterministic state reducer.
class SessionProjector {
    static apply_event(state, event) {
        state.last_seq = event.seq;
        state.updated_at = event.timestamp;
        const p = event.payload || {};
        const etype = event.event_type;
        if (etype === event_types_js_1.EventType.SESSION_CREATED) {
            state.title = p.title || state.title;
            state.created_at = event.timestamp;
            Object.assign(state.metadata, p.metadata || {});
        }
        else if (etype === event_types_js_1.EventType.SESSION_FORKED) {
            state.title = p.title || `Fork of ${p.source_session_id}`;
            state.created_at = event.timestamp;
        }
        else if (etype === event_types_js_1.EventType.SESSION_CLOSED) {
            state.status = "closed";
        }
        else if (etype === event_types_js_1.EventType.USER_MESSAGE_SUBMITTED) {
            const msg_id = p.message_id || `user_${event.seq}`;
            state.messages.push({
                id: msg_id, role: "user", content: p.content || "",
                msg_type: "message", metadata: p.metadata || {},
                created_at: event.timestamp, seq: event.seq,
            });
        }
        else if (etype === event_types_js_1.EventType.AGENT_TURN_STARTED) {
            state.status = "running";
            state.current_turn = event.turn || state.current_turn + 1;
        }
        else if (etype === event_types_js_1.EventType.AGENT_TURN_COMPLETED) {
            state.status = "idle";
        }
        else if (etype === event_types_js_1.EventType.AGENT_TURN_PAUSED) {
            state.status = "paused";
        }
        else if (etype === event_types_js_1.EventType.AGENT_TURN_CANCELLED) {
            state.status = "idle";
        }
        else if (etype === event_types_js_1.EventType.LLM_RESPONSE_COMPLETED) {
            const msg_id = p.message_id || `assistant_${event.seq}`;
            state.messages.push({
                id: msg_id, role: "assistant", content: p.content || "",
                msg_type: "message",
                metadata: {
                    tool_calls: event.tool_calls || [],
                    reasoning: p.reasoning || "",
                    ...p.metadata || {},
                },
                created_at: event.timestamp, seq: event.seq,
            });
        }
        else if (etype === event_types_js_1.EventType.TOOL_EXECUTION_STARTED) {
            const tool_id = event.call_id || `call_${event.seq}`;
            state.active_tools[tool_id] = {
                id: tool_id, tool_name: p.tool_name, args: p.args || {},
                started_at: event.timestamp, status: "running",
            };
        }
        else if (etype === event_types_js_1.EventType.TOOL_EXECUTION_COMPLETED) {
            const tool_id = event.call_id || `call_${event.seq}`;
            if (tool_id in state.active_tools) {
                state.active_tools[tool_id].status = "completed";
                state.active_tools[tool_id].result = event.result;
                state.active_tools[tool_id].completed_at = event.timestamp;
            }
        }
        else if (etype === event_types_js_1.EventType.TOOL_EXECUTION_FAILED) {
            const tool_id = event.call_id || `call_${event.seq}`;
            if (tool_id in state.active_tools) {
                state.active_tools[tool_id].status = "failed";
                state.active_tools[tool_id].error = event.error;
                state.active_tools[tool_id].completed_at = event.timestamp;
            }
        }
        else if (etype === event_types_js_1.EventType.CONTEXT_FOLD_COMPLETED) {
            const summary = p.summary;
            if (summary) {
                state.metadata["last_compaction"] = {
                    at_seq: event.seq, summary,
                    folded_events_count: event.folded_events_count || 0,
                };
            }
        }
        return state;
    }
}
exports.SessionProjector = SessionProjector;
// TODO(port): ProjectionEngine requires EventStore.
class ProjectionEngine {
    constructor(_store) { }
    project_session(_session_id, _at_seq) {
        throw new Error("ProjectionEngine.project_session requires EventStore");
    }
}
exports.ProjectionEngine = ProjectionEngine;
let _projection_engine = null;
function get_projection_engine(event_store) {
    if (_projection_engine === null || event_store !== undefined) {
        _projection_engine = new ProjectionEngine(event_store);
    }
    return _projection_engine;
}
// PORT STATUS: confidence=medium todos=[1]
// TODO(port): implement ProjectionEngine once event_store.ts is translated.
