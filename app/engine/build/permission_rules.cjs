"use strict";
/**
 * permission_rules.ts 鈥?Persistent permission rules: match by tool + arg pattern.
 *
 * Ported from `app/backend/permission_rules.py` (416 lines).
 *
 * RULEBOOK CITATIONS:
 * - 搂2 enums 鈫?string literal unions.
 * - 搂1 node: builtins (node:crypto for uuid equivalent).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports._BEHAVIOR_RANK = exports.PermissionRuleStore = exports.PermissionRule = exports._BUILTIN_RULES = exports._BUILTIN_TOOLS = void 0;
exports.call_signature = call_signature;
exports.suggest_pattern = suggest_pattern;
exports.get_permission_rules = get_permission_rules;
exports.set_permission_rules = set_permission_rules;
const node_crypto_1 = require("node:crypto");
const _BEHAVIOR_RANK = { allow: 0, ask: 1, deny: 2 };
exports._BEHAVIOR_RANK = _BEHAVIOR_RANK;
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const _COMMAND_KEYS = ["command", "cmd", "script", "code"];
const _PATH_KEYS = ["path", "file_path", "filepath", "target", "filename", "file"];
const _INTERPRETER_HEADS = new Set([
    "python", "python3", "py", "node", "nodejs", "deno", "bun", "ruby", "perl",
    "php", "sh", "bash", "zsh", "powershell", "pwsh", "cmd", "osascript",
]);
exports._BUILTIN_TOOLS = ["bash", "shell_executor"];
exports._BUILTIN_RULES = [
    ["git status", "鏌ョ湅 git 鐘舵€?],
    ["git status *", "鏌ョ湅 git 鐘舵€?],
    ["git diff", "鏌ョ湅 git diff"],
    ["git diff *", "鏌ョ湅 git diff"],
    ["git log *", "鏌ョ湅 git 鏃ュ織"],
    ["git branch", "鏌ョ湅 git 鍒嗘敮"],
    ["git branch *", "鏌ョ湅 git 鍒嗘敮"],
    ["ls", "鍒楀嚭鐩綍"],
    ["ls *", "鍒楀嚭鐩綍"],
    ["dir", "鍒楀嚭鐩綍"],
    ["dir *", "鍒楀嚭鐩綍"],
    ["pwd", "鏌ョ湅褰撳墠鐩綍"],
    ["where *", "鏌ユ壘鍙墽琛屾枃浠?],
    ["which *", "鏌ユ壘鍙墽琛屾枃浠?],
    ["pytest *", "杩愯 pytest"],
    ["python -m pytest *", "杩愯 pytest"],
    ["python -m unittest *", "杩愯 unittest"],
    ["python -m py_compile *", "Python 璇硶妫€鏌?],
    ["python *.py", "杩愯 python 鑴氭湰"],
    ["python *.py *", "杩愯 python 鑴氭湰"],
    ["npx tsc *", "TypeScript 绫诲瀷妫€鏌?],
    ["tsc *", "TypeScript 绫诲瀷妫€鏌?],
    ["npm run typecheck*", "绫诲瀷妫€鏌ヨ剼鏈?],
    ["go vet *", "Go 闈欐€佹鏌?],
    ["go build *", "Go 缂栬瘧妫€鏌?],
    ["cargo check *", "Rust 缂栬瘧妫€鏌?],
    ["cargo clippy *", "Rust lint"],
    ["ruff *", "Python lint"],
    ["eslint *", "JS/TS lint"],
    ["npx eslint *", "JS/TS lint"],
];
// ---------------------------------------------------------------------------
// call_signature
// ---------------------------------------------------------------------------
function call_signature(tool_name, args) {
    const a = args || {};
    for (const key of _COMMAND_KEYS) {
        const v = a[key];
        if (typeof v === "string" && v.trim()) {
            return v.trim().split(/\s+/).join(" ");
        }
    }
    for (const key of _PATH_KEYS) {
        const v = a[key];
        if (typeof v === "string" && v.trim()) {
            return v.trim().replace(/\\/g, "/");
        }
    }
    return "";
}
// ---------------------------------------------------------------------------
// suggest_pattern helpers
// ---------------------------------------------------------------------------
function _looks_like_subcommand(token) {
    if (!token || token.startsWith("-"))
        return false;
    return !/[/\\.="']/.test(token);
}
function suggest_pattern(tool_name, args) {
    const a = args || {};
    const is_command = _COMMAND_KEYS.some((k) => {
        const v = a[k];
        return typeof v === "string" && v.trim().length > 0;
    });
    if (!is_command)
        return "";
    const sig = call_signature(tool_name, a);
    const tokens = sig.split(/\s+/);
    if (tokens.length === 0)
        return "";
    const head = tokens[0];
    const rest = tokens.slice(1);
    const parts = [head];
    if (rest.length >= 2 && (rest[0] === "-m" || rest[0] === "--module") && _looks_like_subcommand(rest[1])) {
        parts.push(rest[0], rest[1]);
    }
    else if (rest.length > 0 && _looks_like_subcommand(rest[0])) {
        parts.push(rest[0]);
    }
    else if (rest.length > 0 && _INTERPRETER_HEADS.has(head.toLowerCase())) {
        parts.push(rest[0]);
    }
    return parts.join(" ") + " *";
}
// ---------------------------------------------------------------------------
// fnmatch-compatible glob matching
// ---------------------------------------------------------------------------
function _fnmatch(text, pattern) {
    // Convert glob pattern to regex.
    let regex = "";
    for (const ch of pattern) {
        if (ch === "*")
            regex += ".*";
        else if (ch === "?")
            regex += ".";
        else if ("+^$(){}|[].".includes(ch))
            regex += "\\" + ch;
        else
            regex += ch;
    }
    return new RegExp("^" + regex + "$", "i").test(text);
}
function _pattern_matches(pattern, signature) {
    if (!pattern)
        return true;
    const p = pattern.toLowerCase();
    const sig = signature.toLowerCase();
    if (_fnmatch(sig, p))
        return true;
    if (p.endsWith(" *") && _fnmatch(sig, p.slice(0, -2)))
        return true;
    return false;
}
// ---------------------------------------------------------------------------
// PermissionRule dataclass
// ---------------------------------------------------------------------------
class PermissionRule {
    tool_name;
    pattern;
    behavior;
    scope;
    workspace_root;
    session_id;
    source;
    note;
    id;
    created_at;
    constructor(opts) {
        this.tool_name = opts.tool_name;
        this.pattern = opts.pattern ?? "";
        this.behavior = opts.behavior ?? "allow";
        this.scope = opts.scope ?? "workspace";
        this.workspace_root = opts.workspace_root ?? "";
        this.session_id = opts.session_id ?? "";
        this.source = opts.source ?? "user";
        this.note = opts.note ?? "";
        this.id = opts.id ?? (0, node_crypto_1.randomUUID)().replace(/-/g, "");
        this.created_at = opts.created_at ?? Date.now() / 1000;
    }
}
exports.PermissionRule = PermissionRule;
// ---------------------------------------------------------------------------
// PermissionRuleStore (TODO(port): storage-backed persistence)
// ---------------------------------------------------------------------------
class PermissionRuleStore {
    _rules = [];
    // TODO(port): wire to storage once storage.ts is translated.
    // For now, rules are in-memory only.
    constructor(_storage) {
        this._seed_builtins();
    }
    _seed_builtins() {
        for (const tool of exports._BUILTIN_TOOLS) {
            for (const [pattern, note] of exports._BUILTIN_RULES) {
                this._rules.push(new PermissionRule({
                    tool_name: tool,
                    pattern,
                    behavior: "allow",
                    scope: "global",
                    source: "builtin",
                    note,
                }));
            }
        }
    }
    add(rule) {
        this._rules = this._rules.filter((r) => r.id !== rule.id);
        this._rules.push(rule);
        return rule;
    }
    remove(rule_id) {
        const before = this._rules.length;
        this._rules = this._rules.filter((r) => r.id !== rule_id);
        return this._rules.length !== before;
    }
    list(workspace_root = "", session_id = "") {
        const out = this._rules.filter((r) => this._applies(r, workspace_root, session_id));
        return out.sort((a, b) => b.created_at - a.created_at);
    }
    _applies(rule, workspace_root, session_id) {
        if (rule.scope === "global")
            return true;
        if (rule.scope === "workspace") {
            return !workspace_root || !rule.workspace_root || rule.workspace_root === workspace_root;
        }
        return !session_id || !rule.session_id || rule.session_id === session_id;
    }
    match(tool_name, args, workspace_root = "", session_id = "") {
        const sig = call_signature(tool_name, args);
        const candidates = this._rules.filter((r) => r.tool_name === tool_name
            && this._applies(r, workspace_root, session_id)
            && _pattern_matches(r.pattern, sig));
        if (candidates.length === 0)
            return null;
        return candidates.reduce((best, r) => (_BEHAVIOR_RANK[r.behavior] > _BEHAVIOR_RANK[best.behavior] ||
            (_BEHAVIOR_RANK[r.behavior] === _BEHAVIOR_RANK[best.behavior] && r.created_at > best.created_at))
            ? r : best);
    }
}
exports.PermissionRuleStore = PermissionRuleStore;
// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------
let _store = null;
function get_permission_rules() {
    if (_store === null) {
        _store = new PermissionRuleStore();
    }
    return _store;
}
function set_permission_rules(store) {
    _store = store;
}
// PORT STATUS: confidence=medium todos=[1]
// TODO(port): wire PermissionRuleStore to SQLite via storage.ts once translated.
