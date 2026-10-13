"use strict";
/**
 * agent_logger.ts 鈥?Agent & Tool Debugging Logger.
 *
 * Ported from `app/backend/agent_logger.py` (128 lines).
 *
 * RULEBOOK CITATIONS:
 * - 搂1 node: builtins (node:fs, node:path).
 *
 * NOTES:
 * - Python's logging module replaced with simple console + file output.
 * - SafeStreamHandler logic (errors='replace' for Windows GBK) preserved
 *   via explicit encoding in file writes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.log_turn_start = log_turn_start;
exports.log_reasoning_step = log_reasoning_step;
exports.log_tool_dispatch = log_tool_dispatch;
exports.log_tool_result = log_tool_result;
exports.log_turn_end = log_turn_end;
const fs = require("node:fs");
const path = require("node:path");
const _LOG_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "logs");
const _LOG_FILE = path.join(_LOG_DIR, "agent_debug.log");
let _initialized = false;
function _ensure_init() {
    if (_initialized)
        return;
    _initialized = true;
    try {
        fs.mkdirSync(_LOG_DIR, { recursive: true });
    }
    catch {
        // fail-open: optional enhancement
    }
}
function _log(level, message) {
    _ensure_init();
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const line = `[${ts}] [${level}] ${message}`;
    // Console output
    if (level === "INFO" || level === "WARN" || level === "ERROR") {
        console.log(`[Agent Debug] ${message}`);
    }
    // File output (UTF-8, append)
    try {
        fs.appendFileSync(_LOG_FILE, line + "\n", "utf-8");
    }
    catch {
        // fail-open: optional enhancement
    }
}
function log_turn_start(session_id, turn_index, prompt, permission, model) {
    _log("INFO", `>> TURN START [#${turn_index}] Session=${session_id.slice(0, 8)} Mode=${permission} Model=${model}\n   User Prompt: ${prompt.slice(0, 200)}`);
}
function log_reasoning_step(step, reasoning) {
    const preview = reasoning.trim().replace(/\n/g, " ").slice(0, 200);
    _log("INFO", `   [Step ${step}] Thought: ${preview}...`);
}
function log_tool_dispatch(tool_name, args, call_id, permission, confirmed, sandbox_mode) {
    const args_json = JSON.stringify(args);
    _log("INFO", `   [TOOL DISPATCH] \`${tool_name}\` (callId=${call_id.slice(0, 8)})\n      Args: ${args_json.slice(0, 300)}\n      Auth: mode=${permission}, confirmed=${confirmed}, sandbox=${sandbox_mode}`);
}
function log_tool_result(tool_name, call_id, ok, status, duration_ms, result_preview, error) {
    const tag = ok ? "[SUCCESS]" : "[FAILED]";
    const detail = error ? `Error: ${error}` : `Output: ${result_preview.slice(0, 200)}`;
    _log("INFO", `   ${tag} TOOL RESULT: \`${tool_name}\` [${status}] in ${duration_ms.toFixed(1)}ms\n      ${detail}`);
}
function log_turn_end(session_id, turn_index, total_steps, duration_s) {
    _log("INFO", `<< TURN END [#${turn_index}] Steps=${total_steps} Duration=${duration_s.toFixed(2)}s\n${"=".repeat(60)}`);
}
// PORT STATUS: confidence=high todos=[0]
