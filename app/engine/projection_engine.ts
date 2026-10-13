/**
 * projection_engine.ts — High-Fidelity State Projection & Time-Travel Engine.
 *
 * Ported from `app/backend/projection_engine.py` (265 lines).
 *
 * RULEBOOK CITATIONS:
 * - §2 dataclass → interface + class; `asdict` → toDict.
 * - §2 `p.get("title", state.title)` etc — the Python default is used even
 *   when the payload key exists with a falsy value only if the key is ABSENT;
 *   `?? ` reproduces exactly that (absent/undefined → default).
 * - §2 `state.current_turn = p.get("turn", state.current_turn + 1)` — the
 *   default is computed from state; `?? ` keeps that.
 * - §2 TraceGateway composition in fork_at_seq matches the source (a fresh
 *   gateway over the same store).
 * - §4 naming: projection_engine.py → projection_engine.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import { EventType } from "./event_types.js";
import type { AgentEvent } from "./event_types.js";
import type { EventStore } from "./event_store.js";
import { get_event_store } from "./event_store.js";
import { TraceGateway } from "./trace_gateway.js";

export interface ProjectedSessionStateFields {
    session_id: string;
    title?: string;
    status?: string;
    created_at?: number;
    updated_at?: number;
    current_turn?: number;
    last_seq?: number;
    goal_state?: Record<string, unknown> | null;
    messages?: Record<string, unknown>[];
    active_tools?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}

export class ProjectedSessionState {
    session_id: string;
    title: string;
    status: string;
    created_at: number;
    updated_at: number;
    current_turn: number;
    last_seq: number;
    goal_state: Record<string, unknown> | null;
    messages: Record<string, unknown>[];
    active_tools: Record<string, unknown>;
    metadata: Record<string, unknown>;

    constructor(opts: ProjectedSessionStateFields) {
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

    toDict(): Record<string, unknown> {
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

    static fromDict(data: Record<string, unknown>): ProjectedSessionState {
        return new ProjectedSessionState({
            session_id: data.session_id as string,
            title: data.title as string | undefined,
            status: data.status as string | undefined,
            created_at: data.created_at as number | undefined,
            updated_at: data.updated_at as number | undefined,
            current_turn: data.current_turn as number | undefined,
            last_seq: data.last_seq as number | undefined,
            goal_state: (data.goal_state as Record<string, unknown> | null | undefined) ?? null,
            messages: (data.messages as Record<string, unknown>[] | undefined) ?? [],
            active_tools: (data.active_tools as Record<string, unknown> | undefined) ?? {},
            metadata: (data.metadata as Record<string, unknown> | undefined) ?? {},
        });
    }
}

// Pure deterministic state reducer.

// ---------------------------------------------------------------------------
// python-semantics helpers — payload reads go through pget() so a key that is
// PRESENT with a null value stays null, exactly like dict.get(key, dflt).
// (The earlier `|| dflt` folding was a parity bug surfaced by the checkpoint
// dual probe: python `p.get("content", "")` yields None for {"content": None}.)
// ---------------------------------------------------------------------------

class TypeErrorP extends Error {
    pyMsg: string;
    constructor(msg: string) {
        super(`TypeError: ${msg}`);
        this.name = "TypeError";
        this.pyMsg = msg;
    }
}
class ValueErrorP extends Error {
    pyMsg: string;
    constructor(msg: string) {
        super(`ValueError: ${msg}`);
        this.name = "ValueError";
        this.pyMsg = msg;
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    return "dict";
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return true;
}

/** python dict.get(key, dflt)：present-but-None 返回 None，而不是 dflt。 */
function pget(p: Record<string, unknown>, key: string, dflt: unknown): unknown {
    return key in p ? p[key] : dflt;
}

/** python str(x)（f-string 插入语义；容器 str()==repr()）。 */
function pyStrVal(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number" || typeof v === "string") return String(v);
    if (Array.isArray(v)) return "[" + v.map(pyReprVal).join(", ") + "]";
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).map((k) => pyReprVal(k) + ": " + pyReprVal(o[k])).join(", ") + "}";
}

function pyReprVal(v: unknown): string {
    if (typeof v === "string") {
        const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
        const esc = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
        return '"' + esc.replaceAll('"', '\\"') + '"';
    }
    return pyStrVal(v);
}

/** JSON-key folding: python emits {None:..}->"null", {True:..}->"true",
 *  {5:..}->"5" through json.dumps — mirror that for update() pair keys. */
function pyJsonKey(k: unknown): string {
    if (k === null || k === undefined) return "null";
    if (typeof k === "boolean") return k ? "true" : "false";
    if (typeof k === "number") return String(k);
    if (typeof k === "string") return k;
    return pyStrVal(k);
}

/** python dict.update(x)：mapping 直拷；序列按 pair；其余如实抛。 */
function pyDictUpdateMerge(target: Record<string, unknown>, x: unknown): void {
    if (typeof x === "object" && x !== null && !Array.isArray(x)) {
        Object.assign(target, x as Record<string, unknown>);
        return;
    }
    if (x === null || x === undefined || typeof x === "number" || typeof x === "boolean") {
        throw new TypeErrorP(`'${pyTypeName(x)}' object is not iterable`);
    }
    const items: unknown[] = typeof x === "string" ? Array.from(x) : x as unknown[];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let seq: unknown[] | null = null;
        if (Array.isArray(item)) seq = item;
        else if (typeof item === "string") seq = Array.from(item);
        if (seq === null) {
            throw new TypeErrorP(`cannot convert dictionary update sequence element #${i} to a sequence`);
        }
        if (seq.length !== 2) {
            throw new ValueErrorP(
                `dictionary update sequence element #${i} has length ${seq.length}; 2 is required`);
        }
        target[pyJsonKey(seq[0])] = seq[1];
    }
}

export class SessionProjector {
    static apply_event(state: ProjectedSessionState, event: AgentEvent | {
        seq: number;
        event_type: string;
        timestamp: number;
        payload?: Record<string, unknown> | null;
        call_id?: string | null;
        result?: unknown;
        error?: string | null;
    }): ProjectedSessionState {
        state.last_seq = event.seq;
        state.updated_at = event.timestamp;
        const p = event.payload || {};
        // AgentEvent carries camelCase fields; the loose object shape (used by
        // callers holding pre-hydration rows) carries snake_case. Normalize.
        const etype = (event as { eventType?: string }).eventType ??
            (event as { event_type?: string }).event_type ?? "";

        if (etype === EventType.SESSION_CREATED) {
            state.title = pget(p, "title", state.title) as string;
            state.created_at = event.timestamp;
            pyDictUpdateMerge(state.metadata, pget(p, "metadata", {}));
        } else if (etype === EventType.SESSION_FORKED) {
            // python: p.get("title", f"Fork of {p.get('source_session_id')}")
            // —— 默认值即时求值，缺 source 时 str(None) = "None"。
            const defTitle = "Fork of " + pyStrVal(pget(p, "source_session_id", null));
            state.title = pget(p, "title", defTitle) as string;
            state.created_at = event.timestamp;
        } else if (etype === EventType.SESSION_CLOSED) {
            state.status = "closed";
        } else if (etype === EventType.USER_MESSAGE_SUBMITTED) {
            const msg_id = (p["message_id"] as string) || `user_${event.seq}`;
            state.messages.push({
                id: msg_id, role: "user", content: pget(p, "content", ""),
                msg_type: "message", metadata: pget(p, "metadata", {}),
                created_at: event.timestamp, seq: event.seq,
            });
        } else if (etype === EventType.AGENT_TURN_STARTED) {
            state.status = "running";
            state.current_turn = pget(p, "turn", state.current_turn + 1) as number;
        } else if (etype === EventType.AGENT_TURN_COMPLETED) {
            state.status = "idle";
        } else if (etype === EventType.AGENT_TURN_PAUSED) {
            state.status = "paused";
        } else if (etype === EventType.AGENT_TURN_CANCELLED) {
            state.status = "idle";
        } else if (etype === EventType.LLM_RESPONSE_COMPLETED) {
            const msg_id = (p["message_id"] as string) || `assistant_${event.seq}`;
            // python: {tool_calls:.., reasoning:.., **p.get("metadata", {})}
            // —— 非 mapping 的 metadata 在解包处如实抛 TypeError。
            const llmMeta = pget(p, "metadata", {});
            if (llmMeta === null || typeof llmMeta !== "object" || Array.isArray(llmMeta)) {
                throw new TypeErrorP(`'${pyTypeName(llmMeta)}' object is not a mapping`);
            }
            state.messages.push({
                id: msg_id, role: "assistant", content: pget(p, "content", ""),
                msg_type: "message",
                metadata: {
                    tool_calls: pget(p, "tool_calls", []),
                    reasoning: pget(p, "reasoning", ""),
                    ...(llmMeta as Record<string, unknown>),
                },
                created_at: event.timestamp, seq: event.seq,
            });
        } else if (etype === EventType.TOOL_EXECUTION_STARTED) {
            // Python: p.get("call_id") or f"call_{event.seq}" — the payload's
            // call_id, falling back to the synthesized id. (The stub version
            // read event.call_id, which the source does not.)
            const tool_id = (p["call_id"] as string) || `call_${event.seq}`;
            state.active_tools[tool_id] = {
                id: tool_id, tool_name: pget(p, "tool_name", null),
                args: pget(p, "args", {}),
                started_at: event.timestamp, status: "running",
            };
        } else if (etype === EventType.TOOL_EXECUTION_COMPLETED) {
            const tool_id = (p["call_id"] as string) || `call_${event.seq}`;
            if (tool_id in state.active_tools) {
                (state.active_tools[tool_id] as Record<string, unknown>)["status"] = "completed";
                (state.active_tools[tool_id] as Record<string, unknown>)["result"] = pget(p, "result", null);
                (state.active_tools[tool_id] as Record<string, unknown>)["completed_at"] = event.timestamp;
            }
        } else if (etype === EventType.TOOL_EXECUTION_FAILED) {
            const tool_id = (p["call_id"] as string) || `call_${event.seq}`;
            if (tool_id in state.active_tools) {
                (state.active_tools[tool_id] as Record<string, unknown>)["status"] = "failed";
                (state.active_tools[tool_id] as Record<string, unknown>)["error"] = pget(p, "error", null);
                (state.active_tools[tool_id] as Record<string, unknown>)["completed_at"] = event.timestamp;
            }
        } else if (etype === EventType.CONTEXT_FOLD_COMPLETED) {
            // Compacted context event
            const summary = pget(p, "summary", null);
            if (pyTruth(summary)) {
                state.metadata["last_compaction"] = {
                    at_seq: event.seq, summary,
                    folded_events: pget(p, "folded_events_count", 0),
                };
            }
        }

        return state;
    }
}

/** Orchestrates snapshot recovery and stream projection. */
export class ProjectionEngine {
    event_store: EventStore;

    constructor(event_store?: EventStore | null) {
        this.event_store = event_store ?? get_event_store();
    }

    project_session(session_id: string, at_seq?: number | null): ProjectedSessionState {
        // Projects full session state from the event stream, snapshot-accelerated.
        let initial_state = new ProjectedSessionState({ session_id });
        let from_seq = 0;

        const latest_snapshot = this.event_store.get_latest_snapshot(session_id);
        if (latest_snapshot && (at_seq === null || at_seq === undefined || latest_snapshot.atSeq <= at_seq)) {
            initial_state = ProjectedSessionState.fromDict(
                latest_snapshot.state as Record<string, unknown>
            );
            from_seq = latest_snapshot.atSeq + 1;
        }

        const events = this.event_store.read_stream(session_id, from_seq, at_seq ?? null);

        let state = initial_state;
        for (const ev of events) {
            state = SessionProjector.apply_event(state, ev);
        }

        return state;
    }

    fork_at_seq(
        source_session_id: string,
        fork_point_seq: number,
        new_session_id: string,
        new_title?: string | null
    ): ProjectedSessionState {
        // Precise Time-Travel Fork: copy events up to fork_point_seq into the
        // new session, re-anchoring their chain hashes to the new session.
        const source_events = this.event_store.read_stream(
            source_session_id,
            0,
            fork_point_seq
        );

        const title = new_title || `Fork of ${source_session_id} @ seq ${fork_point_seq}`;
        new TraceGateway(this.event_store).append({
            session_id: new_session_id,
            event_type: EventType.SESSION_FORKED,
            payload: {
                source_session_id,
                fork_point_seq,
                title,
                lineage_root: source_session_id,
            },
            importance: "critical",
            idempotency_key: `session:fork:${new_session_id}`,
            actor: "system",
        });

        const batch_to_clone: {
            event_type: string;
            payload: Record<string, unknown>;
            causation_id: string;
            timestamp: number;
            run_id?: string | null;
            turn_id?: string | null;
            step_id?: string | null;
            tool_call_id?: string | null;
            goal_id?: string | null;
            branch_id?: string | null;
            actor?: string | null;
        }[] = [];
        for (const ev of source_events) {
            // Skip the original session created event
            if (ev.eventType === EventType.SESSION_CREATED || ev.eventType === EventType.SESSION_FORKED) {
                continue;
            }
            batch_to_clone.push({
                event_type: ev.eventType,
                payload: ev.payload,
                causation_id: `clone_from_${source_session_id}_${ev.seq}`,
                timestamp: ev.timestamp,
                // Attribution travels with the fork (see source comment).
                run_id: ev.runId,
                turn_id: ev.turnId,
                step_id: ev.stepId,
                tool_call_id: ev.toolCallId,
                goal_id: ev.goalId,
                branch_id: ev.branchId,
                actor: ev.actor,
            });
        }

        if (batch_to_clone.length > 0) {
            this.event_store.append_batch(new_session_id, batch_to_clone);
        }

        // Project and return state of the newly forked session
        return this.project_session(new_session_id);
    }
}

let _projection_engine: ProjectionEngine | null = null;
export function get_projection_engine(event_store?: EventStore | null): ProjectionEngine {
    if (_projection_engine === null || event_store !== undefined) {
        _projection_engine = new ProjectionEngine(event_store ?? null);
    }
    return _projection_engine;
}
