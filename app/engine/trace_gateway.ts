/**
 * trace_gateway.ts — Canonical append gateway into the EventStore.
 *
 * Ported from `app/backend/trace_gateway.py` (181 lines).
 *
 * RULEBOOK CITATIONS:
 * - §1 node: builtins.
 * - §2 `except ValueError: raise` narrow-catch preserved (programming errors
 *   fail fast regardless of importance); the retry-then-raise / retry-then-drop
 *   importance policy is reproduced exactly.
 * - §2 CPython str accounting reproduced explicitly rather than approximated:
 *   `str[:n]` counts CODEPOINTS and `encode("utf-8", "replace")` charges one
 *   byte for a lone surrogate. See _cpSlice / _pyUtf8Bytes.
 * - §2 Python logging → console.warn/error (established substitute, HANDOFF
 *   §2.7).
 *
 * PORT STATUS: confidence=high todos=0
 */

import { EventType } from "./event_types.js";
import { AgentEvent } from "./event_types.js";
import type { EventStore } from "./event_store.js";
import { get_event_store } from "./event_store.js";

export const CRITICAL = "critical";
export const OBSERVATIONAL = "observational";

const _SENSITIVE_KEY_RE = /(?:^|_)(?:token|password|passwd|secret|api_?key|auth(?:orization)?|cookie|private_?key|credential)s?(?:_|$)/i;
const _MAX_PAYLOAD_BYTES = 256 * 1024;
const _TRUNCATE_AT_BYTES = 64 * 1024;

const _KNOWN_TYPES: ReadonlySet<string> = new Set(Object.values(EventType));

// ── CPython byte/char accounting (bug-for-bug) ─────────────────────────────
// The source guards with `len(node.encode("utf-8", "replace"))` and then slices
// with `node[:_TRUNCATE_AT_BYTES]`. Two CPython facts follow that V8 does not
// share, so both are reproduced explicitly (probe evidence: tn#astral_* and
// tn#lone_surrogate_* rows, see tmp/trg_STATE.md):
//   * `encode("utf-8", "replace")` charges ONE byte for a LONE surrogate ("?"),
//     where Buffer.byteLength charges three (U+FFFD);
//   * `str[:n]` counts CODEPOINTS, where String.prototype.slice counts UTF-16
//     code units (one astral char = two units).
function _pyUtf8Bytes(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
            if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; }
            else n += 1; // lone high surrogate -> "?" (1 byte), not U+FFFD (3)
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            n += 1; // lone low surrogate -> "?" (1 byte)
        } else if (c < 0x80) {
            n += 1;
        } else if (c < 0x800) {
            n += 2;
        } else {
            n += 3;
        }
    }
    return n;
}

function _cpSlice(s: string, n: number): string {
    let i = 0;
    let k = 0;
    while (i < s.length && k < n) {
        const c = s.charCodeAt(i);
        const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < s.length
            && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff;
        i += pair ? 2 : 1;
        k++;
    }
    return s.slice(0, i);
}

export function sanitize_payload(payload: Record<string, unknown>): Record<string, unknown> {
    function redact(node: unknown): unknown {
        if (typeof node === "object" && node !== null) {
            if (Array.isArray(node)) {
                return node.map(redact);
            }
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(node)) {
                if (typeof v === "string" && _SENSITIVE_KEY_RE.test(k)) {
                    out[k] = "[REDACTED]";
                } else {
                    out[k] = redact(v);
                }
            }
            return out;
        }
        if (typeof node === "string" && _pyUtf8Bytes(node) > _TRUNCATE_AT_BYTES) {
            // The guard counts BYTES, the cut counts CODEPOINTS (source quirk,
            // reproduced - not "fixed"): an astral-heavy string is cut at fewer
            // bytes than the constant suggests, and the source does not extend
            // the cut to a code-point boundary because it never needed to.
            return _cpSlice(node, _TRUNCATE_AT_BYTES) + "…[truncated by trace gateway]";
        }
        return node;
    }
    return redact(payload) as Record<string, unknown>;
}

export class TraceGateway {
    private _store: EventStore | null | undefined;

    constructor(store?: EventStore | null) {
        this._store = store ?? null;
        // Python: __init__(self, store=None) stores None as None. undefined →
        // null keeps the lazy-store branch below the only lazy path.
    }

    get store(): EventStore {
        // Lazy: in tests the store singleton is re-pointed at a fresh temp
        // dir constantly, and a gateway bound at construction time would keep
        // writing to a deleted directory.
        if (this._store != null) {
            return this._store;
        }
        return get_event_store();
    }

    append(opts: {
        session_id: string;
        event_type: unknown;
        payload: Record<string, unknown>;
        importance?: string;
        idempotency_key?: string | null;
        causation_id?: string | null;
        run_id?: string | null;
        turn_id?: string | null;
        step_id?: string | null;
        tool_call_id?: string | null;
        goal_id?: string | null;
        branch_id?: string | null;
        parent_event_id?: string | null;
        actor?: string | null;
        visibility?: string;
    }): AgentEvent | null {
        const {
            session_id,
            event_type,
            payload,
            importance = OBSERVATIONAL,
            idempotency_key = null,
            causation_id = null,
            run_id = null,
            turn_id = null,
            step_id = null,
            tool_call_id = null,
            goal_id = null,
            branch_id = null,
            parent_event_id = null,
            actor = null,
            visibility = "audit",
        } = opts;
        // -- validation: caller bugs, fail fast regardless of importance
        if (!session_id || typeof session_id !== "string") {
            throw new RangeError("event needs a non-empty session_id");
        }
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new RangeError(
                `payload must be a dict, got ${payload === null ? "None" : Array.isArray(payload) ? "list" : typeof payload}`
            );
        }
        const etype = String(event_type);
        if (!_KNOWN_TYPES.has(etype)) {
            throw new RangeError(`unknown event_type ${JSON.stringify(etype)} — extend EventType first`);
        }

        const clean = sanitize_payload(payload);
        let encoded: string;
        try {
            encoded = JSON.stringify(clean);
        } catch (exc) {
            throw new RangeError(`payload is not JSON-serializable: ${exc}`);
        }
        if (_pyUtf8Bytes(encoded) > _MAX_PAYLOAD_BYTES) {
            throw new RangeError(
                `payload exceeds ${_MAX_PAYLOAD_BYTES} bytes even after truncation of long strings`
            );
        }

        // -- write, honouring importance on failure
        const attempts = importance === CRITICAL ? 2 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                return this.store.append(session_id, etype, clean, {
                    causation_id,
                    idempotency_key,
                    run_id,
                    turn_id,
                    step_id,
                    tool_call_id,
                    goal_id,
                    branch_id,
                    parent_event_id,
                    actor,
                    visibility,
                });
            } catch (exc) {
                if (exc instanceof RangeError) {
                    throw exc;
                }
                if (attempt + 1 < attempts) {
                    console.warn(`trace append failed (${exc}), retrying`);
                    continue;
                }
                if (importance === CRITICAL) {
                    throw exc;
                }
                // Observational: the trace mirror must never take down the
                // feature it observes — but the loss is logged, never silent.
                console.error(
                    "observational event write failed and was dropped: " +
                        `session=${session_id} type=${etype} key=${idempotency_key}`,
                    exc
                );
                return null;
            }
        }
        return null; // unreachable; keeps type-checkers honest
    }
}

export { _KNOWN_TYPES };
