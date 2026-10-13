/**
 * permission_rules.ts — Persistent permission rules: match by tool + arg pattern.
 *
 * Ported from `app/backend/permission_rules.py` (416 lines).
 *
 * RULEBOOK CITATIONS:
 * - §2 enums → string literal unions.
 * - §1 node: builtins (node:crypto for uuid equivalent).
 */

import { randomUUID } from "node:crypto";

import { get_storage } from "./storage.js";
import type { SqliteConnection, Row } from "./sqlite_connection.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const RuleBehavior = {
    ALLOW: "allow",
    ASK: "ask",
    DENY: "deny",
} as const;
export type RuleBehavior = (typeof RuleBehavior)[keyof typeof RuleBehavior];

const _BEHAVIOR_RANK: Record<RuleBehavior, number> = { allow: 0, ask: 1, deny: 2 };

export const RuleScope = {
    SESSION: "session",
    WORKSPACE: "workspace",
    GLOBAL: "global",
} as const;
export type RuleScope = (typeof RuleScope)[keyof typeof RuleScope];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const _COMMAND_KEYS = ["command", "cmd", "script", "code"] as const;
const _PATH_KEYS = ["path", "file_path", "filepath", "target", "filename", "file"] as const;

const _INTERPRETER_HEADS = new Set([
    "python", "python3", "py", "node", "nodejs", "deno", "bun", "ruby", "perl",
    "php", "sh", "bash", "zsh", "powershell", "pwsh", "cmd", "osascript",
]);

export const _BUILTIN_TOOLS = ["bash", "shell_executor"] as const;

export const _BUILTIN_RULES: ReadonlyArray<readonly [string, string]> = [
    ["git status", "查看 git 状态"],
    ["git status *", "查看 git 状态"],
    ["git diff", "查看 git diff"],
    ["git diff *", "查看 git diff"],
    ["git log *", "查看 git 日志"],
    ["git branch", "查看 git 分支"],
    ["git branch *", "查看 git 分支"],
    ["ls", "列出目录"],
    ["ls *", "列出目录"],
    ["dir", "列出目录"],
    ["dir *", "列出目录"],
    ["pwd", "查看当前目录"],
    ["where *", "查找可执行文件"],
    ["which *", "查找可执行文件"],
    ["pytest *", "运行 pytest"],
    ["python -m pytest *", "运行 pytest"],
    ["python -m unittest *", "运行 unittest"],
    ["python -m py_compile *", "Python 语法检查"],
    ["python *.py", "运行 python 脚本"],
    ["python *.py *", "运行 python 脚本"],
    ["npx tsc *", "TypeScript 类型检查"],
    ["tsc *", "TypeScript 类型检查"],
    ["npm run typecheck*", "类型检查脚本"],
    ["go vet *", "Go 静态检查"],
    ["go build *", "Go 编译检查"],
    ["cargo check *", "Rust 编译检查"],
    ["cargo clippy *", "Rust lint"],
    ["ruff *", "Python lint"],
    ["eslint *", "JS/TS lint"],
    ["npx eslint *", "JS/TS lint"],
];

// ---------------------------------------------------------------------------
// call_signature
// ---------------------------------------------------------------------------

export function call_signature(tool_name: string, args?: Record<string, unknown>): string {
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

function _looks_like_subcommand(token: string): boolean {
    if (!token || token.startsWith("-")) return false;
    return !/[/\\.="']/.test(token);
}

export function suggest_pattern(tool_name: string, args?: Record<string, unknown>): string {
    const a = args || {};
    const is_command = _COMMAND_KEYS.some((k) => {
        const v = a[k];
        return typeof v === "string" && v.trim().length > 0;
    });
    if (!is_command) return "";
    const sig = call_signature(tool_name, a);
    const tokens = sig.split(/\s+/);
    if (tokens.length === 0) return "";
    const head = tokens[0]!;
    const rest = tokens.slice(1);
    const parts = [head];
    if (rest.length >= 2 && (rest[0] === "-m" || rest[0] === "--module") && _looks_like_subcommand(rest[1]!)) {
        parts.push(rest[0]!, rest[1]!);
    } else if (rest.length > 0 && _looks_like_subcommand(rest[0]!)) {
        parts.push(rest[0]!);
    } else if (rest.length > 0 && _INTERPRETER_HEADS.has(head.toLowerCase())) {
        parts.push(rest[0]!);
    }
    return parts.join(" ") + " *";
}

// ---------------------------------------------------------------------------
// fnmatch-compatible glob matching
// ---------------------------------------------------------------------------

function _fnmatch(text: string, pattern: string): boolean {
    // Convert glob pattern to regex.
    let regex = "";
    for (const ch of pattern) {
        if (ch === "*") regex += ".*";
        else if (ch === "?") regex += ".";
        else if ("+^$(){}|[].".includes(ch)) regex += "\\" + ch;
        else regex += ch;
    }
    return new RegExp("^" + regex + "$", "i").test(text);
}

function _pattern_matches(pattern: string, signature: string): boolean {
    if (!pattern) return true;
    const p = pattern.toLowerCase();
    const sig = signature.toLowerCase();
    if (_fnmatch(sig, p)) return true;
    if (p.endsWith(" *") && _fnmatch(sig, p.slice(0, -2))) return true;
    return false;
}

// ---------------------------------------------------------------------------
// PermissionRule dataclass
// ---------------------------------------------------------------------------

export class PermissionRule {
    tool_name: string;
    pattern: string;
    behavior: RuleBehavior;
    scope: RuleScope;
    workspace_root: string;
    session_id: string;
    source: string;
    note: string;
    id: string;
    created_at: number;

    constructor(opts: {
        tool_name: string;
        pattern?: string;
        behavior?: RuleBehavior;
        scope?: RuleScope;
        workspace_root?: string;
        session_id?: string;
        source?: string;
        note?: string;
        id?: string;
        created_at?: number;
    }) {
        this.tool_name = opts.tool_name;
        this.pattern = opts.pattern ?? "";
        this.behavior = opts.behavior ?? "allow";
        this.scope = opts.scope ?? "workspace";
        this.workspace_root = opts.workspace_root ?? "";
        this.session_id = opts.session_id ?? "";
        this.source = opts.source ?? "user";
        this.note = opts.note ?? "";
        this.id = opts.id ?? randomUUID().replace(/-/g, "");
        this.created_at = opts.created_at ?? Date.now() / 1000;
    }
}

// ---------------------------------------------------------------------------
// PermissionRuleStore (SQLite-backed persistence via storage.ts)
// ---------------------------------------------------------------------------

/** storage 形状（结构性）：_db 池化连接 + kv 哨兵，与 Python Storage 面一致。 */
interface StorageShape {
    _db(name: string): SqliteConnection;
    kv_get(key: string, ns?: string, defaultValue?: unknown): unknown;
    kv_set(key: string, value: unknown, ns?: string): void;
}

export class PermissionRuleStore {
    private _rules: PermissionRule[] = [];
    private _storage: StorageShape;

    constructor(storage?: unknown) {
        // storage is injected in tests; in production it's the process singleton.
        if (storage === null || storage === undefined) {
            this._storage = get_storage() as unknown as StorageShape;
        } else {
            this._storage = storage as StorageShape;
        }
        this._ensure_table();
        this._load();
        this._seed_builtins();
    }

    // ── persistence ──────────────────────────────────────────────

    /** Reuse the configs db — one more small, rarely-written table, no reason
     * to open a ninth connection for it. */
    private _db(): SqliteConnection {
        return this._storage._db("configs");
    }

    private _ensure_table(): void {
        this._db().execute(
            "CREATE TABLE IF NOT EXISTS permission_rules (" +
                "id TEXT PRIMARY KEY, tool_name TEXT, pattern TEXT DEFAULT '', " +
                "behavior TEXT DEFAULT 'allow', scope TEXT DEFAULT 'workspace', " +
                "workspace_root TEXT DEFAULT '', session_id TEXT DEFAULT '', " +
                "source TEXT DEFAULT 'user', note TEXT DEFAULT '', created_at INTEGER)"
        );
    }

    private _row_to_rule(r: Row): PermissionRule {
        return new PermissionRule({
            id: String(r["id"]),
            tool_name: String(r["tool_name"]),
            pattern: String(r["pattern"] ?? ""),
            behavior: String(r["behavior"] ?? "allow") as RuleBehavior,
            scope: String(r["scope"] ?? "workspace") as RuleScope,
            workspace_root: String(r["workspace_root"] ?? ""),
            session_id: String(r["session_id"] ?? ""),
            source: String(r["source"] ?? "user"),
            note: String(r["note"] ?? ""),
            created_at: Number(r["created_at"] ?? 0),
        });
    }

    private _load(): void {
        const rows = this._db().execute("SELECT * FROM permission_rules").fetchall();
        const out: PermissionRule[] = [];
        for (const r of rows) {
            try {
                out.push(this._row_to_rule(r));
            } catch {
                // A row with an enum value this version no longer knows: skip it
                // rather than crash the whole store on one bad record.
                continue;
            }
        }
        this._rules = out;
    }

    private _seed_builtins(): void {
        /** Insert the shipped ALLOW rules once, on first ever boot.
         *
         * Guarded by a kv sentinel rather than by "is this rule missing?",
         * because those two questions differ in exactly the case that matters:
         * a user who deleted a builtin. Re-deriving from absence would
         * resurrect it on the next restart — seeding once means a delete is
         * permanent. */
        if (this._storage.kv_get("permission_rules_seeded", "risk")) {
            return;
        }
        for (const tool of _BUILTIN_TOOLS) {
            for (const [pattern, note] of _BUILTIN_RULES) {
                this.add(
                    new PermissionRule({
                        tool_name: tool,
                        pattern,
                        behavior: "allow" as RuleBehavior,
                        scope: "global" as RuleScope,
                        source: "builtin",
                        note,
                    })
                );
            }
        }
        this._storage.kv_set("permission_rules_seeded", "1", "risk");
    }

    // ── CRUD ─────────────────────────────────────────────────────────

    add(rule: PermissionRule): PermissionRule {
        this._db().execute(
            "INSERT OR REPLACE INTO permission_rules " +
                "(id, tool_name, pattern, behavior, scope, workspace_root, " +
                "session_id, source, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [rule.id, rule.tool_name, rule.pattern, rule.behavior, rule.scope,
             rule.workspace_root, rule.session_id, rule.source, rule.note,
             Math.trunc(rule.created_at)]
        );
        // Keep the cache in step without a full reload.
        this._rules = this._rules.filter((r) => r.id !== rule.id);
        this._rules.push(rule);
        return rule;
    }

    remove(rule_id: string): boolean {
        const before = this._rules.length;
        this._rules = this._rules.filter((r) => r.id !== rule_id);
        this._db().execute("DELETE FROM permission_rules WHERE id=?", [rule_id]);
        return this._rules.length !== before;
    }

    list(workspace_root: string = "", session_id: string = ""): PermissionRule[] {
        const out = this._rules.filter((r) => this._applies(r, workspace_root, session_id));
        return out.sort((a, b) => b.created_at - a.created_at);
    }

    private _applies(rule: PermissionRule, workspace_root: string, session_id: string): boolean {
        if (rule.scope === "global") return true;
        if (rule.scope === "workspace") {
            return !workspace_root || !rule.workspace_root || rule.workspace_root === workspace_root;
        }
        return !session_id || !rule.session_id || rule.session_id === session_id;
    }

    match(
        tool_name: string,
        args: Record<string, unknown>,
        workspace_root: string = "",
        session_id: string = "",
    ): PermissionRule | null {
        const sig = call_signature(tool_name, args);
        const candidates = this._rules.filter(
            (r) => r.tool_name === tool_name
                && this._applies(r, workspace_root, session_id)
                && _pattern_matches(r.pattern, sig),
        );
        if (candidates.length === 0) return null;
        return candidates.reduce((best, r) =>
            (_BEHAVIOR_RANK[r.behavior] > _BEHAVIOR_RANK[best.behavior] ||
                (_BEHAVIOR_RANK[r.behavior] === _BEHAVIOR_RANK[best.behavior] && r.created_at > best.created_at))
                ? r : best
        );
    }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _store: PermissionRuleStore | null = null;

export function get_permission_rules(): PermissionRuleStore {
    if (_store === null) {
        _store = new PermissionRuleStore();
    }
    return _store;
}

export function set_permission_rules(store: PermissionRuleStore | null): void {
    _store = store;
}

export { _BEHAVIOR_RANK };

// PORT STATUS: confidence=high todos=[0]
// Permission rules are persisted to SQLite (configs db) via storage.ts —
// seed-once sentinel via kv_get/kv_set(ns="risk"), matching permission_rules.py.
