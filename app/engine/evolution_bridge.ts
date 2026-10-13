/**
 * evolution_bridge.ts — Bridge connecting Agent runtime events to the
 * Self-Evolution Engine.
 *
 * Ported from `app/backend/evolution_bridge.py` (102 lines).
 *
 * Dispatches interruptions, steering, loop faults and consecutive failures
 * into evolution.db. Strictly adheres to Fail-Open: zero evolution failure
 * may impact user dialogue.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/evolution_bridge.py -> app/engine/evolution_bridge.ts
 *   §2  behaviour: every entry point is fully guarded (broad swallow IS the
 *       module contract, not a defect — do not "fix" it); `reason or
 *       'user cancel'`, `tool_name or "agent_loop"`, `failure_kind or
 *       "tool_unavailable"` falsy gates; `error_msg[:200]` is a *codepoint*
 *       slice (Array.from guard keeps astral chars whole like python).
 *   DIVERGENCE(port): the python in-function `import evolution` becomes an
 *       async dynamic import of "./evolution.js"; until that SPLIT unit
 *       lands the import rejects and every notify_* returns null — the exact
 *       shape of the python ImportError fail-open path.
 *   DIVERGENCE(port): `engine.record(kind=..., ...)` kwargs become one
 *       options object; the future evolution.ts must accept that shape
 *       (same contract note as providers/index.ts).
 *   f-string `{ratio:.1%}` -> (ratio*100).toFixed(1)+"%": both round the same
 *       IEEE double the same way, byte-equal on the probe's values.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

type JsonDict = Record<string, unknown>;

/** Structural view of the (pending SPLIT) evolution engine surface. */
interface EvolutionEngineLike {
    enabled(): boolean;
    record(opts: {
        kind: string;
        tool_name: unknown;
        detail: string;
        session_id: string;
        failure_kind: string | null;
    }): string | null;
}

/** py: `import evolution; evolution.get_evolution_engine()` — any escape
 *  from the import or the call collapses to None. */
async function _get_engine(): Promise<EvolutionEngineLike | null> {
    try {
        const spec = "./evolution" + ".js";
        const mod = (await import(/* @vite-ignore */ spec)) as unknown as {
            get_evolution_engine: () => EvolutionEngineLike;
        };
        return mod.get_evolution_engine();
    } catch {
        return null;
    }
}

/** py `str(x)` inside f-strings: True/False/None keep the python spelling. */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "nan";
        if (v === Infinity) return "inf";
        if (v === -Infinity) return "-inf";
        return String(v);
    }
    if (typeof v === "string") return v;
    try { return JSON.stringify(v) ?? "None"; } catch { return String(v); }
}

/** py truthiness for the `x or default` gates ([] and {} count as falsy). */
function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return Object.keys(v as object).length > 0;
}

/** py `str(exc)` inside the fail-open prints. */
function _pyExc(exc: unknown): string {
    if (exc instanceof Error) return exc.message;
    return String(exc);
}

/** py `print(f"[evolution_bridge] <fn> failed (fail-open): {exc}")` */
function _log(msg: string): void {
    console.log(msg);
}

/** python `s[:200]` counts codepoints, not UTF-16 units. */
function _pySlice200(s: string): string {
    const chars = Array.from(s);
    return chars.length > 200 ? chars.slice(0, 200).join("") : s;
}

/** python `f"{ratio:.1%}"`. */
function _pyPercent(ratio: number): string {
    return (ratio * 100).toFixed(1) + "%";
}

/** Record an interruption event as negative feedback to evolution store. */
export async function notify_turn_interrupted(
    session_id: string, turn_id: unknown, reason: unknown = "",
): Promise<string | null> {
    try {
        const engine = await _get_engine();
        if (!engine || !engine.enabled()) {
            return null;
        }
        return engine.record({
            kind: "interrupted",
            tool_name: "user_action",
            detail: `Turn ${pyStr(turn_id)} interrupted: ${pyTruth(reason) ? pyStr(reason) : "user cancel"}`,
            session_id,
            failure_kind: "tool_unavailable",
        });
    } catch (exc) {
        _log(`[evolution_bridge] notify_turn_interrupted failed (fail-open): ${_pyExc(exc)}`);
        return null;
    }
}

/** Record mid-flight user steering / correction as high-value evolution signal. */
export async function notify_user_correction(
    session_id: string, turn_id: unknown, correction: unknown,
): Promise<string | null> {
    try {
        const engine = await _get_engine();
        if (!engine || !engine.enabled()) {
            return null;
        }
        return engine.record({
            kind: "user_correction",
            tool_name: "user_intervention",
            detail: `Turn ${pyStr(turn_id)} user correction: ${pyStr(correction)}`,
            session_id,
            failure_kind: "user_correction",
        });
    } catch (exc) {
        _log(`[evolution_bridge] notify_user_correction failed (fail-open): ${_pyExc(exc)}`);
        return null;
    }
}

/** Record circuit breaker trips and loop faults. */
export async function notify_loop_fault(
    session_id: string, turn_id: unknown, tool_name: unknown, loop_msg: unknown,
): Promise<string | null> {
    try {
        const engine = await _get_engine();
        if (!engine || !engine.enabled()) {
            return null;
        }
        return engine.record({
            kind: "loop_fault",
            tool_name: pyTruth(tool_name) ? tool_name : "agent_loop",
            detail: `Turn ${pyStr(turn_id)} circuit breaker: ${pyStr(loop_msg)}`,
            session_id,
            failure_kind: "loop_fault",
        });
    } catch (exc) {
        _log(`[evolution_bridge] notify_loop_fault failed (fail-open): ${_pyExc(exc)}`);
        return null;
    }
}

/** Record tool execution failure / rejection with structured failure_kind. */
export async function notify_tool_failure(
    session_id: string, turn_id: unknown, tool_name: unknown, error_msg: string,
    failure_kind: string | null = null,
): Promise<string | null> {
    try {
        const engine = await _get_engine();
        if (!engine || !engine.enabled()) {
            return null;
        }
        return engine.record({
            kind: "tool_failure",
            tool_name: tool_name,
            detail: `Turn ${pyStr(turn_id)} tool '${pyStr(tool_name)}' failed: ${_pySlice200(error_msg)}`,
            session_id,
            failure_kind: pyTruth(failure_kind) ? failure_kind : "tool_unavailable",
        });
    } catch (exc) {
        _log(`[evolution_bridge] notify_tool_failure failed (fail-open): ${_pyExc(exc)}`);
        return null;
    }
}

/** Record context pressure threshold breach as evolution trigger signal. */
export async function notify_context_pressure(
    session_id: string, turn_id: unknown, ratio: number,
): Promise<string | null> {
    try {
        const engine = await _get_engine();
        if (!engine || !engine.enabled()) {
            return null;
        }
        return engine.record({
            kind: "context_pressure",
            tool_name: "context_engine",
            detail: `Turn ${pyStr(turn_id)} context pressure at ${_pyPercent(ratio)}`,
            session_id,
            failure_kind: "context_pressure",
        });
    } catch (exc) {
        _log(`[evolution_bridge] notify_context_pressure failed (fail-open): ${_pyExc(exc)}`);
        return null;
    }
}

// PORT STATUS: confidence=high todos=[0]
