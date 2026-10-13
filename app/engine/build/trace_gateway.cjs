"use strict";
/**
 * trace_gateway.ts 鈥?Canonical append gateway into the EventStore.
 *
 * Ported from `app/backend/trace_gateway.py` (181 lines).
 *
 * RULEBOOK CITATIONS:
 * - 搂1 node: builtins.
 * - 搂2 `except ValueError: raise` narrow-catch preserved (programming errors
 *   fail fast regardless of importance); the retry-then-raise / retry-then-drop
 *   importance policy is reproduced exactly.
 * - 搂2 Python logging 鈫?console.warn/error (established substitute, HANDOFF
 *   搂2.7).
 *
 * PORT STATUS: confidence=high todos=0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports._KNOWN_TYPES = exports.TraceGateway = exports.OBSERVATIONAL = exports.CRITICAL = void 0;
exports.sanitize_payload = sanitize_payload;
const event_types_js_1 = require("./event_types.cjs");
const event_store_js_1 = require("./event_store.cjs");
exports.CRITICAL = "critical";
exports.OBSERVATIONAL = "observational";
const _SENSITIVE_KEY_RE = /(?:^|_)(?:token|password|passwd|secret|api_?key|auth(?:orization)?|cookie|private_?key|credential)s?(?:_|$)/i;
const _MAX_PAYLOAD_BYTES = 256 * 1024;
const _TRUNCATE_AT_BYTES = 64 * 1024;
const _KNOWN_TYPES = new Set(Object.values(event_types_js_1.EventType));
exports._KNOWN_TYPES = _KNOWN_TYPES;
function sanitize_payload(payload) {
    function redact(node) {
        if (typeof node === "object" && node !== null) {
            if (Array.isArray(node)) {
                return node.map(redact);
            }
            const out = {};
            for (const [k, v] of Object.entries(node)) {
                if (typeof v === "string" && _SENSITIVE_KEY_RE.test(k)) {
                    out[k] = "[REDACTED]";
                }
                else {
                    out[k] = redact(v);
                }
            }
            return out;
        }
        if (typeof node === "string" && Buffer.byteLength(node, "utf-8") > _TRUNCATE_AT_BYTES) {
            // Python: node[:_TRUNCATE_AT_BYTES] 鈥?a CODEPOINT slice on str, but
            // the guard counts BYTES. Known source quirk (byte-count + char-slice
            // mismatch documented in HANDOFF 搂6.3) 鈥?reproduced: the TS slice is
            // UTF-16-unit based, matching the "cut less than the byte guard
            // suggests" behaviour of the Python char slice.
            return node.slice(0, _TRUNCATE_AT_BYTES) + "鈥truncated by trace gateway]";
        }
        return node;
    }
    return redact(payload);
}
class TraceGateway {
    _store;
    constructor(store) {
        this._store = store ?? null;
        // Python: __init__(self, store=None) stores None as None. undefined 鈫?        // null keeps the lazy-store branch below the only lazy path.
    }
    get store() {
        // Lazy: in tests the store singleton is re-pointed at a fresh temp
        // dir constantly, and a gateway bound at construction time would keep
        // writing to a deleted directory.
        if (this._store != null) {
            return this._store;
        }
        return (0, event_store_js_1.get_event_store)();
    }
    append(opts) {
        const { session_id, event_type, payload, importance = exports.OBSERVATIONAL, idempotency_key = null, causation_id = null, run_id = null, turn_id = null, step_id = null, tool_call_id = null, goal_id = null, branch_id = null, parent_event_id = null, actor = null, visibility = "audit", } = opts;
        // -- validation: caller bugs, fail fast regardless of importance
        if (!session_id || typeof session_id !== "string") {
            throw new RangeError("event needs a non-empty session_id");
        }
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new RangeError(`payload must be a dict, got ${payload === null ? "None" : Array.isArray(payload) ? "list" : typeof payload}`);
        }
        const etype = String(event_type);
        if (!_KNOWN_TYPES.has(etype)) {
            throw new RangeError(`unknown event_type ${JSON.stringify(etype)} 鈥?extend EventType first`);
        }
        const clean = sanitize_payload(payload);
        let encoded;
        try {
            encoded = JSON.stringify(clean);
        }
        catch (exc) {
            throw new RangeError(`payload is not JSON-serializable: ${exc}`);
        }
        if (Buffer.byteLength(encoded, "utf-8") > _MAX_PAYLOAD_BYTES) {
            throw new RangeError(`payload exceeds ${_MAX_PAYLOAD_BYTES} bytes even after truncation of long strings`);
        }
        // -- write, honouring importance on failure
        const attempts = importance === exports.CRITICAL ? 2 : 1;
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
            }
            catch (exc) {
                if (exc instanceof RangeError) {
                    throw exc;
                }
                if (attempt + 1 < attempts) {
                    console.warn(`trace append failed (${exc}), retrying`);
                    continue;
                }
                if (importance === exports.CRITICAL) {
                    throw exc;
                }
                // Observational: the trace mirror must never take down the
                // feature it observes 鈥?but the loss is logged, never silent.
                console.error("observational event write failed and was dropped: " +
                    `session=${session_id} type=${etype} key=${idempotency_key}`, exc);
                return null;
            }
        }
        return null; // unreachable; keeps type-checkers honest
    }
}
exports.TraceGateway = TraceGateway;
