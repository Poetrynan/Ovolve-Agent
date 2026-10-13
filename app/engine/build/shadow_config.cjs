"use strict";
/**
 * shadow_config.ts 鈥?Shadow workspace runtime configuration.
 *
 * Ported from `app/backend/shadow_config.py` (66 lines).
 *
 * RULEBOOK CITATIONS:
 * - 搂1 node: builtins.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.apply_from_config = apply_from_config;
exports.get_mode = get_mode;
exports.shadow_enabled = shadow_enabled;
exports.shadow_staged = shadow_staged;
exports.shadow_validate_only = shadow_validate_only;
exports.precheck_enabled = precheck_enabled;
exports.apply_patch = apply_patch;
let _runtime_mode = null;
let _runtime_precheck = null;
function apply_from_config(config) {
    const sh = (config || {})["shadow"] || {};
    let mode = String(sh["mode"] || "staged").trim().toLowerCase();
    if (!["off", "validate", "staged"].includes(mode)) {
        mode = "staged";
    }
    _runtime_mode = mode;
    _runtime_precheck = sh["precheck"] !== false;
}
function get_mode() {
    const env = process.env["OVOLVE_SHADOW_MODE"]?.trim().toLowerCase();
    if (env)
        return env;
    return _runtime_mode || "staged";
}
function shadow_enabled() {
    return !["off", "0", "false", "no"].includes(get_mode());
}
function shadow_staged() {
    return shadow_enabled() && get_mode() === "staged";
}
function shadow_validate_only() {
    return shadow_enabled() && get_mode() === "validate";
}
function precheck_enabled() {
    const env = process.env["OVOLVE_SHADOW_PRECHECK"]?.trim().toLowerCase();
    if (env)
        return !["0", "false", "no", "off"].includes(env);
    if (_runtime_precheck === null)
        return true;
    return _runtime_precheck;
}
function apply_patch(patch) {
    const out = {};
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
