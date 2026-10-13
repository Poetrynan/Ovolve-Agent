/**
 * shadow_workspace.ts — 完整影子工作区校验管线（本地优先）
 *
 * Ported from `app/backend/shadow_workspace.py` (439 lines).
 *
 * ## 能力
 *
 * 1. **单文件语法**：py_compile / json / toml
 * 2. **LSP 诊断**：本地 LSP 客户端（有则用，无则跳过）
 * 3. **项目级探针**：复用 ``verify_gate.probe`` + standing permission（tsc / pytest / cargo …）
 * 4. **Staged overlay 全量校验**：对 ``work_copy`` 会话 overlay 中每个改动跑上述检查
 *
 * ## 原则
 *
 * * 零云端、零强制依赖
 * * fail-open：校验器不可用时不阻断（``validate`` 模式下 syntax/LSP error 仍阻断）
 * * 影子文件落在 ``<workspace>/.ovolve/shadow/``
 *
 * RULEBOOK CITATIONS:
 * - §1 node: fs/path/crypto/os builtins; pyodide (AMEND-07 依赖行) for the
 *   real `py_compile` / `tomllib` interpreters.
 * - §2 dataclass → class; asyncio event-bus emits kept async.
 * - §3 DIVERGENCE notes at file end for the interpreter-host swap.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";

import { get_mode, precheck_enabled, shadow_enabled, shadow_staged } from "./shadow_config.js";
import { diagnostics_for_file } from "./lsp_client.js";
import { CodeKnowledgeGraph } from "./code_graph.js";

const SHADOW_SUBDIR = nodePath.join(".ovolve", "shadow", "preview");
const MAX_SHADOW_BYTES = 8 * 1024 * 1024;
const MAX_ISSUES = 50;

export class ShadowIssue {
    checker: string;
    severity: string; // error | warning | info
    message: string;
    path: string;
    line: number;
    character: number;

    constructor(
        checker: string,
        severity: string,
        message: string,
        path = "",
        line = 0,
        character = 0,
    ) {
        this.checker = checker;
        this.severity = severity;
        this.message = message;
        this.path = path;
        this.line = line;
        this.character = character;
    }

    to_dict(): Record<string, unknown> {
        return {
            checker: this.checker,
            severity: this.severity,
            message: this.message,
            path: this.path,
            line: this.line,
            character: this.character,
        };
    }
}

export class ShadowPreview {
    ok: boolean;
    issues: ShadowIssue[];
    shadow_path: string;
    changes: Record<string, unknown>[];
    mode: string;
    pending_apply: boolean;

    constructor(
        ok: boolean,
        opts: {
            issues?: ShadowIssue[];
            shadow_path?: string;
            changes?: Record<string, unknown>[];
            mode?: string;
            pending_apply?: boolean;
        } = {},
    ) {
        this.ok = ok;
        this.issues = opts.issues ?? [];
        this.shadow_path = opts.shadow_path ?? "";
        this.changes = opts.changes ?? [];
        // Python: field(default_factory=get_mode) — evaluated at construction.
        this.mode = opts.mode ?? get_mode();
        this.pending_apply = opts.pending_apply ?? false;
    }

    format_error(): string {
        const errors = this.issues.filter((i) => i.severity === "error");
        if (errors.length === 0) return "";
        const head = errors[0] as ShadowIssue;
        const loc = head.path && head.line ? `${head.path}:${head.line}` : head.path;
        const prefix = loc ? `${loc}: ` : "";
        return `shadow validation failed (${head.checker}): ${prefix}${head.message}`;
    }

    to_dict(): Record<string, unknown> {
        return {
            ok: this.ok,
            issues: this.issues.slice(0, MAX_ISSUES).map((i) => i.to_dict()),
            changes: this.changes,
            mode: this.mode,
            pending_apply: this.pending_apply,
            issue_count: this.issues.length,
            error_count: this.issues.filter((i) => i.severity === "error").length,
            warning_count: this.issues.filter((i) => i.severity === "warning").length,
        };
    }
}

function _isdir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function _resolve_shadow_root(workspace: string): string {
    const ws = (workspace || "").trim();
    if (ws && _isdir(ws)) {
        const root = nodePath.join(ws, SHADOW_SUBDIR);
        try {
            fs.mkdirSync(root, { recursive: true });
            return root;
        } catch {
            /* fall through to the temp fallback */
        }
    }
    const fallback = nodePath.join(os.tmpdir(), "ovolve-shadow", "preview");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
}

function _safe_shadow_path(logical_path: string, workspace: string, ext: string): string {
    const root = _resolve_shadow_root(workspace);
    const digest = crypto
        .createHash("sha256")
        .update(nodePath.normalize(logical_path || "preview"))
        .digest("hex")
        .slice(0, 20);
    const suffix = ext || ".txt";
    return nodePath.join(root, `${digest}${suffix}`);
}

function _write_shadow(logical_path: string, content: string, workspace: string): string {
    if (content === null || content === undefined) content = "";
    if (Buffer.byteLength(content, "utf-8") > MAX_SHADOW_BYTES) {
        throw new Error(`content exceeds shadow limit (${MAX_SHADOW_BYTES} bytes)`);
    }
    const ext = nodePath.extname(String(logical_path).toLowerCase());
    const dest = _safe_shadow_path(logical_path, workspace, ext);
    fs.writeFileSync(dest, content, "utf-8");
    return dest;
}

// ---------------------------------------------------------------------------
// Shared pyodide handle — the real CPython `py_compile` / `tomllib` checkers
// (AMEND-07 dependency row; same seam shape as consistency_auditor.ts).
// ---------------------------------------------------------------------------

interface PyodideHandle {
    runPythonAsync(code: string): Promise<unknown>;
    globals: { set(k: string, v: unknown): void };
}

let _sw_py: PyodideHandle | null = null;
let _sw_loading: Promise<PyodideHandle> | null = null;

function _get_shared_pyodide(mod: {
    loadPyodide: (opts?: { indexURL?: string }) => Promise<PyodideHandle>;
}): Promise<PyodideHandle> {
    if (_sw_py !== null) return Promise.resolve(_sw_py);
    if (_sw_loading === null) {
        _sw_loading = mod.loadPyodide().then((py) => {
            _sw_py = py;
            return py;
        });
    }
    return _sw_loading;
}

async function _shared_pyodide(): Promise<PyodideHandle> {
    const mod = (await import(/* @vite-ignore */ "pyodide")) as unknown as {
        loadPyodide: (opts?: { indexURL?: string }) => Promise<PyodideHandle>;
    };
    return _get_shared_pyodide(mod);
}

async function _checker_python(
    shadow_path: string,
    logical_path: string,
): Promise<ShadowIssue | null> {
    try {
        const py = await _shared_pyodide();
        const content = fs.readFileSync(shadow_path, "utf-8");
        const vname = "/tmp/" + nodePath.basename(shadow_path);
        py.globals.set("_sw_src", content);
        py.globals.set("_sw_file", vname);
        const result = (await py.runPythonAsync(
            [
                "import py_compile as _py_compile",
                "with open(_sw_file, 'w') as _f:",
                "    _f.write(_sw_src)",
                "try:",
                "    _py_compile.compile(_sw_file, cfile='/tmp/ovolve-shadow-check.pyc', doraise=True)",
                "    _sw_res = None",
                "except _py_compile.PyCompileError as _exc:",
                "    _sw_res = str(_exc)",
                "_sw_res",
            ].join("\n"),
        )) as string | null | undefined;
        if (result === null || result === undefined) return null;
        return new ShadowIssue("python_syntax", "error", String(result), logical_path);
    } catch (exc) {
        return new ShadowIssue("python_syntax", "error", String(exc), logical_path);
    }
}

function _checker_json(logical_path: string, content: string): ShadowIssue | null {
    try {
        // Python's json.loads accepts the bare tokens NaN/Infinity/-Infinity;
        // JSON.parse does not. Neutralise them so the *syntax* verdict matches.
        JSON.parse(content.replace(/-?\b(?:NaN|Infinity)\b/g, "null"));
        return null;
    } catch (exc) {
        let line = 0;
        const m = /line (\d+)/.exec(String(exc));
        if (m) line = parseInt(m[1] as string, 10);
        return new ShadowIssue("json_syntax", "error", String(exc), logical_path, line);
    }
}

async function _checker_toml(logical_path: string, content: string): Promise<ShadowIssue | null> {
    try {
        const py = await _shared_pyodide();
        py.globals.set("_sw_toml_src", content);
        const result = (await py.runPythonAsync(
            [
                "import tomllib as _tomllib",
                "try:",
                "    _tomllib.loads(_sw_toml_src)",
                "    _sw_res = None",
                "except Exception as _exc:",
                "    _sw_res = str(_exc)",
                "_sw_res",
            ].join("\n"),
        )) as string | null | undefined;
        if (result === null || result === undefined) return null;
        return new ShadowIssue("toml_syntax", "error", String(result), logical_path);
    } catch (exc) {
        // Source parity: `import tomllib` failing is itself caught by the
        // except-Exception branch and reported as a toml_syntax error.
        return new ShadowIssue("toml_syntax", "error", String(exc), logical_path);
    }
}

function _checker_lsp(workspace: string, logical_path: string, content: string): ShadowIssue[] {
    try {
        const diags = diagnostics_for_file(workspace, logical_path, content);
        return diags.map(
            (d) =>
                new ShadowIssue(
                    `lsp_${d.source}`,
                    d.severity === "error" || d.severity === "warning" ? d.severity : "info",
                    d.message,
                    logical_path,
                    d.line,
                    d.character,
                ),
        );
    } catch {
        return [];
    }
}

function _checker_code_graph_impact(
    workspace: string,
    logical_path: string,
    content: string,
): ShadowIssue[] {
    /** Pre-check impact using CodeKnowledgeGraph when modifying Python files. */
    if (!logical_path.endsWith(".py") || !workspace) return [];
    try {
        const db_path = nodePath.join(workspace, ".ovolve", "code_graph.db");
        if (!fs.existsSync(db_path)) return [];
        const kg = new CodeKnowledgeGraph(db_path);
        const issues: ShadowIssue[] = [];
        try {
            const existing_syms = kg.get_file_symbols(logical_path) as Record<string, unknown>[];
            for (const sym of existing_syms) {
                const sname = String(sym["name"] ?? "");
                if (
                    !content.includes(`def ${sname}`) &&
                    !content.includes(`class ${sname}`) &&
                    !content.includes(`async def ${sname}`)
                ) {
                    const impact = kg.assess_symbol_impact(sname) as Record<string, unknown>;
                    const caller_count = Number(impact["caller_count"] ?? 0);
                    const affected = (impact["affected_files"] as unknown[] | undefined) ?? [];
                    if (caller_count > 0) {
                        issues.push(
                            new ShadowIssue(
                                "code_graph_impact",
                                "warning",
                                `Symbol '${sname}' was removed or renamed but has ${caller_count} external callers in ${affected.length} file(s).`,
                                logical_path,
                                Number(sym["line"] ?? 0),
                            ),
                        );
                    }
                }
            }
        } finally {
            try {
                kg.close();
            } catch {
                /* best effort */
            }
        }
        return issues;
    } catch {
        return [];
    }
}

async function _validate_content(
    workspace: string,
    logical_path: string,
    content: string,
): Promise<ShadowIssue[]> {
    if (!logical_path) return [];
    const ext = nodePath.extname(String(logical_path).toLowerCase());
    const issues: ShadowIssue[] = [];
    let shadow_path = "";
    try {
        shadow_path = _write_shadow(logical_path, content, workspace);
    } catch (exc) {
        return [new ShadowIssue("shadow_io", "warning", String(exc), logical_path)];
    }

    if (ext === ".py") {
        const hit = await _checker_python(shadow_path, logical_path);
        if (hit) issues.push(hit);
    } else if (ext === ".json") {
        const hit = _checker_json(logical_path, content);
        if (hit) issues.push(hit);
    } else if (ext === ".toml") {
        const hit = await _checker_toml(logical_path, content);
        if (hit) issues.push(hit);
    }

    issues.push(..._checker_lsp(workspace, logical_path, content));
    issues.push(..._checker_code_graph_impact(workspace, logical_path, content));
    return issues;
}

/**
 * 单文件拟写入预览 + 校验（``file_agent`` 落盘前调用）。
 *
 * Python 的 ``preview_write`` 是同步的；TS 侧 syntax/toml 检查依赖异步的
 * pyodide 绑定，因此返回 Promise（DIVERGENCE 说明见文件尾）。
 */
export async function preview_write(
    logical_path: string,
    content: string,
    workspace = "",
): Promise<ShadowPreview> {
    if (!precheck_enabled() || !shadow_enabled() || !logical_path || content === null || content === undefined) {
        return new ShadowPreview(true, { mode: get_mode() });
    }

    const issues = await _validate_content(workspace, logical_path, content);
    const has_error = issues.some((i) => i.severity === "error");
    // validate 模式：error 阻断；staged 模式：单文件 error 也阻断 overlay 写入
    const block = has_error;
    return new ShadowPreview(!block, { issues, mode: get_mode() });
}

function _read_overlay_file(wc: { root: string }, rel: string): string {
    const full = nodePath.join(wc.root, ...rel.split("/"));
    try {
        return fs.readFileSync(full, "utf-8");
    } catch {
        return "";
    }
}

/** 对 staged overlay 中全部改动做完整校验。 */
export async function validate_workcopy(
    wc: import("./work_copy.js").WorkCopy | null | undefined,
    workspace: string,
): Promise<ShadowPreview> {
    if (wc === null || wc === undefined) {
        return new ShadowPreview(true, { mode: get_mode() });
    }
    const changes = wc.changes();
    const issues: ShadowIssue[] = [];
    for (const row of changes) {
        const rel = row.rel;
        if (row.kind === "delete") continue;
        const logical = nodePath.join(workspace, ...rel.split("/"));
        const content = _read_overlay_file(wc, rel);
        issues.push(...(await _validate_content(workspace, logical, content)));
    }

    const verify_root = _materialize_verify_tree(workspace, wc);
    if (verify_root) {
        issues.push(...(await _checker_project(verify_root)));
    }

    const has_error = issues.some((i) => i.severity === "error");
    return new ShadowPreview(!has_error, {
        issues,
        changes: changes as unknown as Record<string, unknown>[],
        mode: get_mode(),
        pending_apply: shadow_staged() && changes.length > 0,
    });
}

/** 把 overlay 改动 + 项目配置文件物化到 verify-tree，供项目级命令使用。 */
function _materialize_verify_tree(
    workspace: string,
    wc: import("./work_copy.js").WorkCopy | null | undefined,
): string {
    if (wc === null || wc === undefined || !workspace) return "";
    const base = nodePath.join(nodePath.dirname(wc.root), "verify-tree");
    try {
        fs.rmSync(base, { recursive: true, force: true });
        fs.mkdirSync(base, { recursive: true });
    } catch {
        return "";
    }

    // 项目根配置
    for (const name of [
        "package.json", "tsconfig.json", "jsconfig.json",
        "pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini",
        "Cargo.toml", "go.mod", "Makefile",
    ]) {
        const src = nodePath.join(workspace, name);
        if (fs.existsSync(src)) {
            try {
                fs.copyFileSync(src, nodePath.join(base, name));
            } catch {
                /* skip */
            }
        }
    }

    // 常见源码根（仅复制目录结构 + overlay 覆盖）
    for (const sub of ["src", "app", "lib", "tests", "test"]) {
        const ws_sub = nodePath.join(workspace, sub);
        if (_isdir(ws_sub)) {
            try {
                _copy_tree_merge(ws_sub, nodePath.join(base, sub));
            } catch {
                /* skip */
            }
        }
    }

    // overlay 改动覆盖
    for (const row of wc.changes()) {
        const rel = row.rel;
        const dest = nodePath.join(base, ...rel.split("/"));
        if (row.kind === "delete") {
            if (_isfile(dest)) {
                try {
                    fs.rmSync(dest);
                } catch {
                    /* skip */
                }
            }
            continue;
        }
        const src = nodePath.join(wc.root, ...rel.split("/"));
        try {
            fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
        } catch {
            /* skip */
        }
    }

    return base;
}

function _isfile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

const _COPYTREE_IGNORE = new Set([
    "node_modules", "__pycache__", ".git", "target", "dist", "build",
]);

/** shutil.copytree(dirs_exist_ok=True) + ignore_patterns(...) — merge copy. */
function _copy_tree_merge(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (_COPYTREE_IGNORE.has(entry.name)) continue;
        const s = nodePath.join(src, entry.name);
        const d = nodePath.join(dest, entry.name);
        if (entry.isDirectory()) _copy_tree_merge(s, d);
        else if (entry.isFile()) {
            try {
                fs.copyFileSync(s, d);
            } catch {
                /* mirror the source's OSError tolerance per-file? copytree
                   aborts the whole tree — the outer try/catch mirrors that. */
                throw new Error(`copy failed: ${s}`);
            }
        }
    }
}

/** Run verify_gate probes against a materialized verify tree. Permission-gated. */
async function _checker_project(workspace: string): Promise<ShadowIssue[]> {
    const issues: ShadowIssue[] = [];
    let vg: typeof import("./verify_gate.js");
    let ex: typeof import("./executors.js");
    try {
        // Dynamic import mirrors the source's function-level imports and keeps
        // the verify_gate ↔ shadow_workspace cycle out of module init.
        vg = await import("./verify_gate.js");
        ex = await import("./executors.js");
    } catch {
        return issues;
    }
    for (const cmd of vg.probe(workspace)) {
        const [allowed, why] = vg.is_allowed(cmd.command, workspace);
        if (!allowed) {
            issues.push(new ShadowIssue(
                "project_verify", "info",
                `skipped ${cmd.kind} (${cmd.source}): ${why}`,
            ));
            continue;
        }
        try {
            const proc = await ex.guardedSpawn(cmd.command, { timeout: 120, cwd: workspace });
            const rc = Number(proc.returncode || 0);
            if (rc === 0) continue;
            const raw = ((proc.stdout || "") + (proc.stderr || "")).slice(0, 600);
            issues.push(new ShadowIssue(
                "project_verify", "error",
                raw || `${cmd.command} exited ${rc}`,
                cmd.source,
            ));
        } catch (exc) {
            issues.push(new ShadowIssue("project_verify", "warning", String(exc)));
        }
    }
    return issues;
}

/** 校验当前 staged overlay 并通过 event bus 推送 UI。 */
export async function validate_and_emit(
    bus: import("./event_bus.js").EventBus,
    session_id: string,
    workspace: string,
    _context: Record<string, unknown>,
): Promise<ShadowPreview> {
    const ss = await import("./shadow_session.js");
    const wc = ss.get_session(session_id);
    if (wc === null || !shadow_staged()) {
        return new ShadowPreview(true, { mode: get_mode() });
    }
    const report = await validate_workcopy(wc, workspace);
    try {
        await bus.emit("shadow_validation", {
            session_id,
            workspace,
            ...report.to_dict(),
        });
    } catch {
        /* UI push is best-effort, exactly as in the source */
    }
    return report;
}

/** 自主/全权模式下，校验通过则自动合并 overlay。 */
export async function maybe_auto_apply(
    bus: import("./event_bus.js").EventBus,
    session_id: string,
    workspace: string,
    permission: string,
): Promise<Record<string, unknown> | null> {
    const ss = await import("./shadow_session.js");
    if (!shadow_staged()) return null;
    if (permission !== "full" && permission !== "autonomous") return null;
    const wc = ss.get_session(session_id);
    if (wc === null || wc.changes().length === 0) return null;
    const report = await validate_workcopy(wc, workspace);
    if (!report.ok) {
        try {
            await bus.emit("shadow_validation", {
                session_id,
                workspace,
                ...report.to_dict(),
                auto_apply_blocked: true,
            });
        } catch {
            /* best-effort */
        }
        return null;
    }
    const result = ss.apply_session(session_id);
    try {
        await bus.emit("shadow_applied", {
            session_id,
            workspace,
            applied: (result["applied"] as string[] | undefined) ?? [],
            deleted: (result["deleted"] as string[] | undefined) ?? [],
            conflicts: (result["conflicts"] as Record<string, unknown> | undefined) ?? {},
            errors: (result["errors"] as unknown[] | undefined) ?? [],
        });
    } catch {
        /* best-effort */
    }
    return result;
}

export function cleanup_workspace_shadow(workspace: string): number {
    const ws = (workspace || "").trim();
    if (!ws) return 0;
    const target = nodePath.join(ws, ".ovolve", "shadow");
    if (!_isdir(target)) return 0;
    try {
        let count = 0;
        const stack = [target];
        while (stack.length) {
            const dir = stack.pop() as string;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) stack.push(nodePath.join(dir, entry.name));
                else if (entry.isFile()) count++;
            }
        }
        fs.rmSync(target, { recursive: true, force: true });
        return count;
    } catch {
        return 0;
    }
}

// PORT STATUS: confidence=high todos=[0]
// DIVERGENCE(port): the Python source runs `py_compile` / `tomllib` in-process
// on CPython; here the same stdlib modules run inside pyodide (CPython-in-WASM,
// the AMEND-07 dependency the engine already ships). Verdicts are byte-identical
// (same parser); error-message wording may differ by one interpreter patch
// version, and paths in py_compile messages reference the virtual shadow name.
// DIVERGENCE(port): `preview_write`/`validate_workcopy` are async because the
// pyodide binding is promise-shaped; every consumer awaits them. Source sync
// semantics (block-until-verdict) are preserved.
// DIVERGENCE(port): shutil.copy2 → fs.copyFileSync (bytes only, no mtime); no
// consumer of verify-tree/overlay copies reads timestamps. json.loads accepts
// bare NaN/Infinity — neutralised before JSON.parse so the syntax verdict
// matches; JS parse-error message text differs from Python's.
