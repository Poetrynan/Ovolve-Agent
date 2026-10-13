"use strict";
/**
 * shadow_session.ts 鈥?Per-session shadow workspace (staged overlay).
 *
 * Ported from `app/backend/shadow_session.py` (80+ lines).
 *
 * NOTES:
 * - Depends on `work_copy` (not yet translated). Functions requiring it
 *   are stubbed with TODO(port).
 * - Pure path helpers are fully ported.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.overlay_dir = overlay_dir;
exports.session_meta_dir = session_meta_dir;
exports.ensure_session = ensure_session;
exports.get_session = get_session;
exports.inject_context = inject_context;
const nodePath = require("node:path");
const SESSION_SUBDIR = nodePath.join(".ovolve", "shadow", "session");
function overlay_dir(workspace, session_id) {
    return nodePath.join(workspace, SESSION_SUBDIR, session_id, "overlay");
}
function session_meta_dir(workspace, session_id) {
    return nodePath.join(workspace, SESSION_SUBDIR, session_id);
}
// TODO(port): WorkCopy type from work_copy.ts
function ensure_session(_session_id, _workspace) {
    // Stub 鈥?requires work_copy.ts translation.
    return null;
}
function get_session(_session_id) {
    // Stub 鈥?requires work_copy.ts translation.
    return null;
}
function inject_context(session_id, workspace, context) {
    const wc = ensure_session(session_id, workspace);
    if (wc === null)
        return;
    // context["shadow_session_id"] = session_id; 鈥?once WorkCopy is available.
    void context;
}
// PORT STATUS: confidence=medium todos=[1]
// TODO(port): implement once work_copy.ts is translated.
