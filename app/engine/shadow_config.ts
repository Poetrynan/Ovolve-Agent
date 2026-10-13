/**
 * shadow_config.ts — Shadow workspace runtime configuration.
 *
 * Ported from `app/backend/shadow_config.py` (66 lines).
 *
 * RULEBOOK CITATIONS:
 * - §1 node: builtins.
 */

let _runtime_mode: string | null = null;
let _runtime_precheck: boolean | null = null;

export function apply_from_config(config: Record<string, unknown> | null): void {
    const sh = ((config || {}) as Record<string, unknown>)["shadow"] as Record<string, unknown> || {};
    let mode = String(sh["mode"] || "staged").trim().toLowerCase();
    if (!["off", "validate", "staged"].includes(mode)) {
        mode = "staged";
    }
    _runtime_mode = mode;
    _runtime_precheck = sh["precheck"] !== false;
}

export function get_mode(): string {
    const env = process.env["OVOLVE_SHADOW_MODE"]?.trim().toLowerCase();
    if (env) return env;
    return _runtime_mode || "staged";
}

export function shadow_enabled(): boolean {
    return !["off", "0", "false", "no"].includes(get_mode());
}

export function shadow_staged(): boolean {
    return shadow_enabled() && get_mode() === "staged";
}

export function shadow_validate_only(): boolean {
    return shadow_enabled() && get_mode() === "validate";
}

export function precheck_enabled(): boolean {
    const env = process.env["OVOLVE_SHADOW_PRECHECK"]?.trim().toLowerCase();
    if (env) return !["0", "false", "no", "off"].includes(env);
    if (_runtime_precheck === null) return true;
    return _runtime_precheck;
}

export function apply_patch(patch: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if ("mode" in patch) {
        let mode = String(patch["mode"] || "staged").trim().toLowerCase();
        if (!["off", "validate", "staged"].includes(mode)) {
            mode = "staged";
        }
        _runtime_mode = mode;
        out["mode"] = mode;
    }
    if ("precheck" in patch) {
        const val = patch["precheck"] !== false;
        _runtime_precheck = val;
        out["precheck"] = val;
    }
    return out;
}

// PORT STATUS: confidence=high todos=[0]
