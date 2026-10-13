/**
 * command_audit.ts — 命令执行后审计日志（Post-Execution Audit）.
 *
 * Ported from `app/backend/command_audit.py` (289 lines).
 *
 * ## 解决什么问题
 * 系统有完整的 pre-use 验证链，但缺少**执行后**的审计：高风险命令执行后
 * 改了哪些文件、是否可回滚、是否产生预期外副作用、安全事件记录。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/command_audit.py -> app/engine/command_audit.ts;
 *       snake_case public names and dataclass field names kept verbatim.
 *   §2  latent bug preserved verbatim: RISK_PATTERNS are RAW-STRING regex
 *       text (`r"rm\s+-rf"`) but _assess_risk matches them with plain
 *       substring `pattern.lower() in command` — no re module. A real
 *       `rm -rf /` therefore does NOT match `rm\\s+-rf`; only a command
 *       containing the literal backslash-s text does. Pinned by probe.
 *   §2  `self._entries[-self.max_entries:]` slice semantics incl. the
 *       max_entries=0 -> whole-list quirk and negative max_entries ->
 *       [k:] (double negation). Same for get_recent(limit).
 *   §2  present-but-null: context.get("session_id","") keeps None;
 *       args.get("command","") or args.get("cmd","") — falsy fold on the
 *       or-chain only; a truthy int command survives until `.lower()` in
 *       _assess_risk raises AttributeError (uncaught, bug-for-bug).
 *   §2  os.path.join/normpath follow THIS host (ntpath): join only re-roots
 *       when the second part starts with a separator (drive-abs second part
 *       is concatenated, not honoured); normpath folds / -> \\, drops "."
 *       segments, resolves "..", keeps UNC/drive/root prefix, "" -> ".".
 *       Non-str second arg raises the exact CPython TypeError; non-str
 *       normpath arg raises `'X' object has no attribute 'replace'`.
 *   §2  f-strings interpolate via str(): None -> "None" (write/edit path),
 *       dict/list via repr; `str(args)[:200]` fallback reprs the whole
 *       args dict in insertion order with python quoting.
 *   §2  to_dict: command[:200] is a CODEPOINT slice; level -> .value.
 *   §2  unused `from result import Result` import and the unused dataclass
 *       fields (lines_added/removed, size_before, user_id, duration_ms,
 *       error, files_before/after) are kept — same defaults, same shape.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// python-semantics helpers
// ---------------------------------------------------------------------------

class TypeErrorP extends Error {
    pyMsg: string;
    constructor(msg: string) {
        super(`TypeError: ${msg}`);
        this.name = "TypeError";
        this.pyMsg = msg;
    }
}
class AttributeErrorP extends Error {
    pyMsg: string;
    constructor(msg: string) {
        super(`AttributeError: ${msg}`);
        this.name = "AttributeError";
        this.pyMsg = msg;
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    return "dict";
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return true;
}

/** python str(x)（f-string 插入语义；容器 str()==repr()）。 */
function pyStrVal(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number" || typeof v === "string") return String(v);
    if (Array.isArray(v)) return "[" + v.map(pyReprVal).join(", ") + "]";
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).map((k) => pyReprVal(k) + ": " + pyReprVal(o[k])).join(", ") + "}";
}

function pyReprVal(v: unknown): string {
    if (typeof v === "string") {
        const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
        const esc = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
        return '"' + esc.replaceAll('"', '\\"') + '"';
    }
    return pyStrVal(v);
}

/** python dict.get(key, dflt)：present-but-None 返回 None，而不是 dflt。 */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
        throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
    }
    return key in (obj as object) ? (obj as Record<string, unknown>)[key] : dflt;
}

/** python 负下标切片 a[-n:]（含 -0 === 0 -> 全表 与双负折叠）。 */
function tailSlice<T>(arr: T[], negOf: number): T[] {
    // python semantics: arr[k:] with k = -negOf, EXCEPT k===0 means whole.
    const k = -negOf;
    if (k === 0) {
        return arr.slice();
    }
    if (k > 0) {
        return arr.slice(k);
    }
    return arr.slice(Math.max(arr.length + k, 0));
}

/** python s[:200]（码点）。 */
function pySlice200(s: string): string {
    return Array.from(s).slice(0, 200).join("");
}

// ---------------------------------------------------------------------------
// os.path (ntpath on this host) — verbatim port of CPython 3.13 ntpath
// splitroot/join/normpath (str branch). The interpreter uses the native
// _path_splitroot_ex/_path_normpath which agrees with the pure-Python
// fallbacks below for these inputs.
// ---------------------------------------------------------------------------

const BS = "\\";

/** ntpath.splitroot(str branch). Returns [drive, root, tail]. */
function splitroot(p: string): [string, string, string] {
    const normp = p.replaceAll("/", BS);
    if (normp.slice(0, 1) === BS) {
        if (normp.slice(1, 2) === BS) {
            // UNC drives, e.g. \\server\share or \\?\UNC\server\share
            // Device drives, e.g. \\.\device or \\?\device
            const start = normp.slice(0, 8).toUpperCase() === "\\\\?\\UNC\\" ? 8 : 2;
            const index = normp.indexOf(BS, start);
            if (index === -1) return [p, "", ""];
            const index2 = normp.indexOf(BS, index + 1);
            if (index2 === -1) return [p, "", ""];
            return [p.slice(0, index2), p.slice(index2, index2 + 1), p.slice(index2 + 1)];
        }
        // Relative path with root, e.g. \Windows
        return ["", p.slice(0, 1), p.slice(1)];
    } else if (normp.slice(1, 2) === ":") {
        if (normp.slice(2, 3) === BS) {
            // Absolute drive-letter path, e.g. X:\Windows
            return [p.slice(0, 2), p.slice(2, 3), p.slice(3)];
        }
        // Relative path with drive, e.g. X:Windows
        return [p.slice(0, 2), "", p.slice(2)];
    }
    // Relative path, e.g. Windows
    return ["", "", p];
}

/** ntpath.join(a, b)：盘符绝对 / root / UNC 的第二参数会换根。 */
function osPathJoin(a: unknown, b: unknown): string {
    const bad = (v: unknown): never => {
        throw new TypeErrorP(
            "join() argument must be str, bytes, or os.PathLike object, not '" + pyTypeName(v) + "'");
    };
    if (typeof a !== "string") bad(a);
    if (typeof b !== "string") bad(b);
    let [rd, rr, rp] = splitroot(a as string);
    const [pd, pr, pp] = splitroot(b as string);
    // CPython 循环里三个换根分支都 `continue`——相对拼接块只对"第二参数
    // 相对"的路径执行；换根时不得再把 pp 追加一遍。
    let relocated = false;
    if (pr !== "") {
        // Second path is absolute
        if (pd !== "" || rd === "") {
            rd = pd;
        }
        rr = pr;
        rp = pp;
        relocated = true;
    } else if (pd !== "" && pd !== rd) {
        if (pd.toLowerCase() !== rd.toLowerCase()) {
            // Different drives => ignore the first path entirely
            rd = pd;
            rr = pr;
            rp = pp;
            relocated = true;
        } else {
            // Same drive in different case
            rd = pd;
        }
    }
    if (!relocated) {
        // Second path is relative to the first
        if (rp !== "" && !rp.endsWith("\\") && !rp.endsWith("/")) {
            rp = rp + BS;
        }
        rp = rp + pp;
    }
    // add separator between UNC and non-absolute path
    if (rp !== "" && rr === "" && rd !== "" && !":\\".includes(rd.slice(-1))) {
        return rd + BS + rp;
    }
    return rd + rr + rp;
}

/** ntpath.normpath（纯 Python fallback 算法，本机 native 与之一致）。 */
function osPathNormpath(p: unknown): string {
    if (typeof p !== "string") {
        throw new AttributeErrorP(`'${pyTypeName(p)}' object has no attribute 'replace'`);
    }
    const path = p.replaceAll("/", BS);
    const [drive, root, rest] = splitroot(path);
    const prefix = drive + root;
    const comps = rest.split(BS);
    let i = 0;
    while (i < comps.length) {
        if (comps[i] === "" || comps[i] === ".") {
            comps.splice(i, 1);
        } else if (comps[i] === "..") {
            if (i > 0 && comps[i - 1] !== "..") {
                comps.splice(i - 1, 2);
                i -= 1;
            } else if (i === 0 && root !== "") {
                comps.splice(0, 1);
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    // If the path is now empty, substitute '.'
    if (prefix === "" && comps.length === 0) {
        comps.push(".");
    }
    return prefix + comps.join(BS);
}

/** os.path.exists：不可读路径按 python 返回 False。 */
function osPathExists(p: string): boolean {
    try {
        return fs.existsSync(p);
    } catch {
        return false;
    }
}

/** os.path.getsize。 */
function osPathGetsize(p: string): number {
    return fs.statSync(p).size;
}

// ---------------------------------------------------------------------------
// data model
// ---------------------------------------------------------------------------

export enum AuditLevel {
    INFO = "info",        // 常规操作
    WARN = "warn",        // 需要注意
    ALERT = "alert",      // 高风险操作
    CRITICAL = "critical" // 安全事件
}

/** 文件变更差异 */
export interface FileDiff {
    path: string;
    action: string; // "created" | "modified" | "deleted"
    lines_added: number;
    lines_removed: number;
    size_before: number;
    size_after: number;
}

function makeFileDiff(path: string, action: string, opts: {
    lines_added?: number; lines_removed?: number; size_before?: number; size_after?: number;
} = {}): FileDiff {
    return {
        path, action,
        lines_added: "lines_added" in opts ? opts.lines_added! : 0,
        lines_removed: "lines_removed" in opts ? opts.lines_removed! : 0,
        size_before: "size_before" in opts ? opts.size_before! : 0,
        size_after: "size_after" in opts ? opts.size_after! : 0,
    };
}

/** 审计日志条目 */
export interface AuditEntry {
    id: string;
    timestamp: number;
    level: AuditLevel;
    tool_name: string;
    command: unknown;
    session_id: unknown;
    user_id: string;
    files_before: Record<string, unknown>;
    files_after: Record<string, unknown>;
    diffs: FileDiff[];
    success: boolean;
    duration_ms: number;
    error: string;
    unexpected_changes: string[];
    risk_score: number;
    rollback_available: boolean;
}

function makeAuditEntry(init: {
    tool_name?: unknown; command?: unknown; session_id?: unknown; level?: AuditLevel;
} = {}): AuditEntry {
    return {
        id: randomUUID().replaceAll("-", "").slice(0, 12),
        timestamp: Date.now() / 1000,
        level: "level" in init && init.level !== undefined ? init.level : AuditLevel.INFO,
        tool_name: "tool_name" in init ? init.tool_name as string : "",
        command: "command" in init ? init.command : "",
        session_id: "session_id" in init ? init.session_id : "",
        user_id: "",
        files_before: {},
        files_after: {},
        diffs: [],
        success: true,
        duration_ms: 0,
        error: "",
        unexpected_changes: [],
        risk_score: 0.0,
        rollback_available: false,
    };
}

/** AuditEntry.to_dict() */
export function entryToDict(self: AuditEntry): Record<string, unknown> {
    return {
        id: self.id,
        timestamp: self.timestamp,
        level: self.level as string,
        toolName: self.tool_name,
        command: typeof self.command === "string"
            ? pySlice200(self.command)
            : sliceRaw(self.command, 200),
        sessionId: self.session_id,
        diffs: self.diffs.map((d) => ({
            path: d.path, action: d.action, added: d.lines_added, removed: d.lines_removed,
        })),
        success: self.success,
        durationMs: self.duration_ms,
        unexpectedChanges: self.unexpected_changes,
        riskScore: self.risk_score,
        rollbackAvailable: self.rollback_available,
    };
}

/** python `x[:200]` where x may be any object — non-subscriptable raises. */
function sliceRaw(v: unknown, n: number): unknown {
    if (typeof v === "string") return pySlice200Length(v, n);
    if (Array.isArray(v)) return v.slice(0, n);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not subscriptable`);
}
function pySlice200Length(s: string, n: number): string {
    return Array.from(s).slice(0, n).join("");
}

// ---------------------------------------------------------------------------
// CommandAuditor
// ---------------------------------------------------------------------------

/** 命令执行后审计系统 */
export class CommandAuditor {
    // 需要审计的高风险工具
    readonly AUDIT_TOOLS: Set<string> = new Set([
        "shell_executor", "bash", "run_command", "python_executor",
        "write_file", "edit_file", "delete_file", "move_file",
        "git_commit", "git_push", "git_push_force",
    ]);

    // 命令模式 -> 审计级别（注意：源里这些是 raw-string 正则文本，但
    // _assess_risk 用的是子串匹配——bug-for-bug 保留，见文件头 §2）
    readonly RISK_PATTERNS: Record<string, AuditLevel> = {
        "rm\\s+-rf": AuditLevel.CRITICAL,
        "git\\s+push\\s+--force": AuditLevel.ALERT,
        "git\\s+push\\s+-f": AuditLevel.ALERT,
        "chmod\\s+777": AuditLevel.WARN,
        "curl.*\\|.*sh": AuditLevel.ALERT,
        "wget.*\\|.*sh": AuditLevel.ALERT,
        "sudo": AuditLevel.WARN,
        "dd\\s+if=": AuditLevel.ALERT,
        "mkfs": AuditLevel.CRITICAL,
        "git\\s+reset\\s+--hard": AuditLevel.WARN,
        "git\\s+clean\\s+-fd": AuditLevel.WARN,
    };

    workspace: string;
    max_entries: number;
    _entries: AuditEntry[] = [];

    constructor(workspace_root: string, max_entries = 1000) {
        this.workspace = workspace_root;
        this.max_entries = max_entries;
    }

    /** 执行后审计入口 */
    audit(tool_name: unknown, args: Record<string, unknown>, result: unknown, context: Record<string, unknown>): AuditEntry | null {
        void result;
        // python: `tool_name not in frozenset` —— list/dict 参数在哈希处抛
        // unhashable type（不是静默 False）。
        if (Array.isArray(tool_name) || (tool_name !== null && typeof tool_name === "object")) {
            throw new TypeErrorP(`unhashable type: '${pyTypeName(tool_name)}'`);
        }
        if (!this.AUDIT_TOOLS.has(tool_name as string)) {
            return null;
        }

        const entry = makeAuditEntry({
            tool_name: tool_name as string,
            command: this._extract_command(tool_name as string, args),
            session_id: dictGet(context, "session_id", ""),
        });

        // 1. 计算文件变更
        entry.diffs = this._compute_diffs(args, context);

        // 2. 评估风险级别
        entry.level = this._assess_risk(tool_name as string, args);

        // 3. 检测意外变更
        entry.unexpected_changes = this._detect_unexpected(args, entry.diffs);

        // 4. 计算风险分数
        entry.risk_score = this._calc_risk_score(entry);

        // 5. 检查是否可回滚
        entry.rollback_available = entry.diffs.length > 0;

        // 存储
        this._entries.push(entry);
        if (this._entries.length > this.max_entries) {
            this._entries = tailSlice(this._entries, this.max_entries);
        }

        return entry;
    }

    /** 获取最近的审计条目 */
    get_recent(limit = 50, min_level: AuditLevel = AuditLevel.INFO): AuditEntry[] {
        const filtered = this._entries.filter((e) => this._level_gte(e.level, min_level));
        return tailSlice(filtered, limit);
    }

    /** 获取会话的所有审计条目 */
    get_by_session(session_id: unknown): AuditEntry[] {
        return this._entries.filter((e) => e.session_id === session_id);
    }

    /** 获取风险摘要 */
    get_risk_summary(): Record<string, unknown> {
        const total = this._entries.length;
        const critical = this._entries.filter((e) => e.level === AuditLevel.CRITICAL).length;
        const alert = this._entries.filter((e) => e.level === AuditLevel.ALERT).length;
        const warn = this._entries.filter((e) => e.level === AuditLevel.WARN).length;

        return {
            total,
            critical,
            alert,
            warn,
            highRiskRate: (critical + alert) / Math.max(total, 1),
            recentUnexpected: tailSlice(this._entries, 20)
                .reduce((acc, e) => acc + e.unexpected_changes.length, 0),
        };
    }

    // ── 内部方法 ─────────────────────────────────────────────────────────

    /** 提取命令文本 */
    _extract_command(tool_name: unknown, args: Record<string, unknown>): unknown {
        if (tool_name === "shell_executor" || tool_name === "bash" || tool_name === "run_command") {
            const c = dictGet(args, "command", "");
            return pyTruth(c) ? c : dictGet(args, "cmd", "");
        }
        if (tool_name === "write_file") {
            return "write: " + pyStrVal(dictGet(args, "path", ""));
        }
        if (tool_name === "edit_file") {
            return "edit: " + pyStrVal(dictGet(args, "path", ""));
        }
        if (tool_name === "git_commit") {
            // python: f"git commit: {args.get('message','')[:100]}" — 真值非
            // str 在切片处如实抛 TypeError。
            return "git commit: " + pyStrVal(sliceMsg(dictGet(args, "message", "")));
        }
        if (tool_name === "git_push") {
            return "git push " + pyStrVal(dictGet(args, "remote", "origin")) + " "
                + pyStrVal(dictGet(args, "branch", ""));
        }
        return pySlice200Length(pyStrVal(args), 200);
    }

    /** 计算文件变更 */
    _compute_diffs(args: Record<string, unknown>, context: Record<string, unknown>): FileDiff[] {
        void context;
        const diffs: FileDiff[] = [];
        // 获取编辑的文件
        const affected: unknown[] = [];
        if ("path" in args) affected.push(args["path"]);
        if ("file_path" in args) affected.push(args["file_path"]);
        if ("dst" in args) affected.push(args["dst"]);

        for (const path of affected) {
            const absPath = osPathJoin(this.workspace, path);
            if (osPathExists(absPath)) {
                const size = osPathGetsize(absPath);
                diffs.push(makeFileDiff(path as string, "modified", { size_after: size }));
            } else {
                diffs.push(makeFileDiff(path as string, "deleted"));
            }
        }

        return diffs;
    }

    /** 评估操作风险级别 */
    _assess_risk(tool_name: unknown, args: Record<string, unknown>): AuditLevel {
        const raw = this._extract_command(tool_name, args);
        if (typeof raw !== "string") {
            throw new AttributeErrorP(`'${pyTypeName(raw)}' object has no attribute 'lower'`);
        }
        const command = raw.toLowerCase();
        for (const [pattern, level] of Object.entries(this.RISK_PATTERNS)) {
            if (command.includes(pattern.toLowerCase())) {
                return level;
            }
        }
        // 默认按工具分类
        if (tool_name === "git_push_force" || tool_name === "git_reset_hard" || tool_name === "git_clean") {
            return AuditLevel.ALERT;
        }
        if (tool_name === "shell_executor" || tool_name === "bash" || tool_name === "python_executor") {
            return AuditLevel.WARN;
        }
        return AuditLevel.INFO;
    }

    /** 检测意外变更 */
    _detect_unexpected(args: Record<string, unknown>, diffs: FileDiff[]): string[] {
        const unexpected: string[] = [];
        const expected = new Set<string>();
        if ("path" in args) expected.add(osPathNormpath(args["path"]));
        if ("file_path" in args) expected.add(osPathNormpath(args["file_path"]));

        for (const d of diffs) {
            const norm = osPathNormpath(d.path);
            if (!expected.has(norm)) {
                unexpected.push(d.path);
            }
        }

        return unexpected;
    }

    /** 计算风险分数 0-1 */
    _calc_risk_score(entry: AuditEntry): number {
        let score: number;
        // 基础分
        if (entry.level === AuditLevel.CRITICAL) {
            score = 1.0;
        } else if (entry.level === AuditLevel.ALERT) {
            score = 0.7;
        } else if (entry.level === AuditLevel.WARN) {
            score = 0.4;
        } else {
            score = 0.1;
        }

        // 意外变更加分
        score += Math.min(0.3, entry.unexpected_changes.length * 0.1);

        // 失败加分
        if (!entry.success) {
            score += 0.2;
        }

        return Math.min(1.0, score);
    }

    /** a >= b */
    _level_gte(a: AuditLevel, b: AuditLevel): boolean {
        const order: Record<string, number> = { info: 0, warn: 1, alert: 2, critical: 3 };
        return (order[a as string] ?? 0) >= (order[b as string] ?? 0);
    }
}

/** python: args.get('message','')[:100] —— 非可下标对象如实抛。 */
function sliceMsg(v: unknown): unknown {
    if (typeof v === "string") return Array.from(v).slice(0, 100).join("");
    if (Array.isArray(v)) return v.slice(0, 100);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not subscriptable`);
}

// ── 全局实例 ──────────────────────────────────────────────────────────────

let _auditor: CommandAuditor | null = null;

export function get_command_auditor(workspace_root = ""): CommandAuditor {
    if (_auditor === null) {
        _auditor = new CommandAuditor(workspace_root || process.cwd());
    }
    return _auditor;
}

/** test-only: reset the module singleton (python probes reload the module). */
export function _resetCommandAuditorForTests(): void {
    _auditor = null;
}

// PORT STATUS: confidence=high todos=[0]
