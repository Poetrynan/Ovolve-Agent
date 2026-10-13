/**
 * agent_logger.ts — Agent & Tool Debugging Logger.
 *
 * Ported from `app/backend/agent_logger.py` (128 lines).
 *
 * RULEBOOK CITATIONS:
 * - §1 node: builtins (node:fs, node:path).
 *
 * NOTES:
 * - Python's logging module replaced with simple console + file output.
 * - SafeStreamHandler logic (errors='replace' for Windows GBK) preserved
 *   via explicit encoding in file writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const _LOG_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "logs");
const _LOG_FILE = path.join(_LOG_DIR, "agent_debug.log");

let _initialized = false;

function _ensure_init(): void {
    if (_initialized) return;
    _initialized = true;
    try {
        fs.mkdirSync(_LOG_DIR, { recursive: true });
    } catch {
        // fail-open: optional enhancement
    }
}

function _log(level: string, message: string): void {
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
    } catch {
        // fail-open: optional enhancement
    }
}

export function log_turn_start(
    session_id: string,
    turn_index: number,
    prompt: string,
    permission: string,
    model: string,
): void {
    _log("INFO", `>> TURN START [#${turn_index}] Session=${session_id.slice(0, 8)} Mode=${permission} Model=${model}\n   User Prompt: ${prompt.slice(0, 200)}`);
}

export function log_reasoning_step(step: number, reasoning: string): void {
    const preview = reasoning.trim().replace(/\n/g, " ").slice(0, 200);
    _log("INFO", `   [Step ${step}] Thought: ${preview}...`);
}

export function log_tool_dispatch(
    tool_name: string,
    args: Record<string, unknown>,
    call_id: string,
    permission: string,
    confirmed: boolean,
    sandbox_mode: string,
): void {
    const args_json = JSON.stringify(args);
    _log("INFO", `   [TOOL DISPATCH] \`${tool_name}\` (callId=${call_id.slice(0, 8)})\n      Args: ${args_json.slice(0, 300)}\n      Auth: mode=${permission}, confirmed=${confirmed}, sandbox=${sandbox_mode}`);
}

export function log_tool_result(
    tool_name: string,
    call_id: string,
    ok: boolean,
    status: string,
    duration_ms: number,
    result_preview: string,
    error?: string,
): void {
    const tag = ok ? "[SUCCESS]" : "[FAILED]";
    const detail = error ? `Error: ${error}` : `Output: ${result_preview.slice(0, 200)}`;
    _log("INFO", `   ${tag} TOOL RESULT: \`${tool_name}\` [${status}] in ${duration_ms.toFixed(1)}ms\n      ${detail}`);
}

export function log_turn_end(
    session_id: string,
    turn_index: number,
    total_steps: number,
    duration_s: number,
): void {
    _log("INFO", `<< TURN END [#${turn_index}] Steps=${total_steps} Duration=${duration_s.toFixed(2)}s\n${"=".repeat(60)}`);
}

// PORT STATUS: confidence=high todos=[0]
