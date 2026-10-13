"use strict";
/**
 * verify_gate.ts 鈥?Machine verification for the goal loop (UA4).
 *
 * Ported from `app/backend/verify_gate.py` (272 lines).
 *
 * RULEBOOK CITATIONS:
 * - 搂1 node: builtins.
 * - 搂2 dataclass 鈫?interface + class.
 *
 * TODO(port): verify() and _run_one() need executors.ts (translated) and
 * shadow_workspace.ts (not yet translated). Stubs provided.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VerifyCommand = exports._PERMISSION_TOOL = exports.REPAIR_BUDGET = exports.MAX_VERIFY_OUTPUT_CHARS = exports.VERIFY_TIMEOUT_S = void 0;
exports.probe = probe;
exports.is_allowed = is_allowed;
exports.truncate_output = truncate_output;
exports.repair_prompt = repair_prompt;
exports.verify = verify;
exports.precheck_proposed_content = precheck_proposed_content;
const fs = require("node:fs");
const nodePath = require("node:path");
exports.VERIFY_TIMEOUT_S = 300;
exports.MAX_VERIFY_OUTPUT_CHARS = 3000;
exports.REPAIR_BUDGET = 3;
exports._PERMISSION_TOOL = "shell_executor";
class VerifyCommand {
    command;
    source;
    kind;
    constructor(command, source, kind = "check") {
        this.command = command;
        this.source = source;
        this.kind = kind;
    }
}
exports.VerifyCommand = VerifyCommand;
function _read_json(path) {
    try {
        return JSON.parse(fs.readFileSync(path, "utf-8"));
    }
    catch {
        return null;
    }
}
function _has_python_tests(workspace) {
    const tests_dir = nodePath.join(workspace, "tests");
    if (!fs.existsSync(tests_dir))
        return false;
    const entries = fs.readdirSync(tests_dir, { withFileTypes: true });
    return entries.some((e) => e.name.startsWith("test_") && e.name.endsWith(".py"));
}
function probe(workspace) {
    if (!workspace || !fs.existsSync(workspace))
        return [];
    const out = [];
    const pyproject = nodePath.join(workspace, "pyproject.toml");
    let has_pytest_cfg = false;
    if (fs.existsSync(pyproject)) {
        try {
            const content = fs.readFileSync(pyproject, "utf-8");
            has_pytest_cfg = content.includes("[tool.pytest");
        }
        catch { /* ignore */ }
    }
    if (has_pytest_cfg || _has_python_tests(workspace)) {
        out.push(new VerifyCommand("python -m pytest -q", has_pytest_cfg ? "pyproject.toml [tool.pytest]" : "tests/test_*.py", "test"));
    }
    if (fs.existsSync(nodePath.join(workspace, "tsconfig.json"))) {
        out.push(new VerifyCommand("npx tsc --noEmit", "tsconfig.json", "typecheck"));
    }
    else {
        const pkg = _read_json(nodePath.join(workspace, "package.json"));
        const scripts = pkg?.scripts;
        if (scripts && typeof scripts === "object" && "typecheck" in scripts) {
            out.push(new VerifyCommand("npm run typecheck", "package.json scripts.typecheck", "typecheck"));
        }
    }
    if (fs.existsSync(nodePath.join(workspace, "go.mod"))) {
        out.push(new VerifyCommand("go build ./...", "go.mod", "build"));
    }
    if (fs.existsSync(nodePath.join(workspace, "Cargo.toml"))) {
        out.push(new VerifyCommand("cargo check", "Cargo.toml", "build"));
    }
    return out;
}
function is_allowed(command, workspace) {
    // TODO(port): use permission_rules once fully wired.
    // For now, always allow (matches the behavior when rules are seeded).
    void command;
    void workspace;
    return [true, ""];
}
function truncate_output(text, limit = exports.MAX_VERIFY_OUTPUT_CHARS) {
    text = text || "";
    if (text.length <= limit)
        return text;
    const head = Math.floor(limit / 3);
    const tail = limit - head;
    const omitted = text.length - head - tail;
    return `${text.slice(0, head)}\n鈥?[鐪佺暐 ${omitted} 涓瓧绗 鈥n${text.slice(-tail)}`;
}
function repair_prompt(report) {
    const results = report?.results || [];
    const failed = results.filter((r) => !r?.passed);
    if (failed.length === 0)
        return "";
    const blocks = failed.map((r) => `鍛戒护锛?{r.command}锛堟潵鑷?${r.source}锛塡n閫€鍑虹爜锛?{r.exitCode}\n杈撳嚭锛歕n${r.output || "锛堟棤杈撳嚭锛?}`);
    return ("浣犲垰鎵嶆姤鍛婁换鍔″凡瀹屾垚锛屼絾椤圭洰鑷繁鐨勯獙璇佸懡浠ゆ病鏈夐€氳繃銆傝繖鏄満鍣ㄥ垽瀹氱殑缁撴灉锛? +
        "涓嶆槸鎰忚鈥斺€斿湪楠岃瘉閫氳繃涔嬪墠浠诲姟涓嶇畻瀹屾垚銆俓n\n" +
        blocks.join("\n\n") +
        "\n\n璇峰畾浣嶅苟淇帀涓婇潰鐨勫け璐ュ師鍥狅紝涓嶈缁曡繃楠岃瘉銆佷笉瑕佹敼鍔ㄦ垨鍒犳帀娴嬭瘯鏉ヨ瀹冨彉缁裤€?);
}
// TODO(port): verify() needs executors.guarded_spawn and shadow_workspace.preview_write.
async function verify(_workspace) {
    return { ran: false, passed: false, skipped: true, skipReason: "not yet ported", results: [], summary: "" };
}
function precheck_proposed_content(_path, _content, _workspace = "") {
    return [true, ""];
}
// PORT STATUS: confidence=medium todos=[1]
// TODO(port): implement verify() once shadow_workspace.ts is translated.
