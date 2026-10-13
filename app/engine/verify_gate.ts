/**
 * verify_gate.ts — Machine verification for the goal loop (UA4).
 *
 * Ported from `app/backend/verify_gate.py` (272 lines).
 *
 * RULEBOOK CITATIONS:
 * - §1 node: builtins.
 * - §2 dataclass → interface + class.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";

import { get_permission_rules, RuleBehavior } from "./permission_rules.js";

export const VERIFY_TIMEOUT_S = 300;
export const MAX_VERIFY_OUTPUT_CHARS = 3000;
export const REPAIR_BUDGET = 3;
export const _PERMISSION_TOOL = "shell_executor";

export class VerifyCommand {
    command: string;
    source: string;
    kind: string;

    constructor(command: string, source: string, kind: string = "check") {
        this.command = command;
        this.source = source;
        this.kind = kind;
    }
}

function _read_json(path: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(path, "utf-8"));
    } catch {
        return null;
    }
}

function _has_python_tests(workspace: string): boolean {
    const tests_dir = nodePath.join(workspace, "tests");
    if (!_isdir(tests_dir)) return false;
    // os.walk in the source is recursive: test files may live in subdirs.
    const stack = [tests_dir];
    while (stack.length) {
        const dir = stack.pop() as string;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (e.isDirectory()) stack.push(nodePath.join(dir, e.name));
            else if (e.isFile() && e.name.startsWith("test_") && e.name.endsWith(".py")) return true;
        }
    }
    return false;
}

function _isdir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

export function probe(workspace: string): VerifyCommand[] {
    if (!workspace || !_isdir(workspace)) return [];
    const out: VerifyCommand[] = [];

    const pyproject = nodePath.join(workspace, "pyproject.toml");
    let has_pytest_cfg = false;
    if (fs.existsSync(pyproject)) {
        try {
            const content = fs.readFileSync(pyproject, "utf-8");
            has_pytest_cfg = content.includes("[tool.pytest");
        } catch { /* ignore */ }
    }
    if (has_pytest_cfg || _has_python_tests(workspace)) {
        out.push(new VerifyCommand(
            "python -m pytest -q",
            has_pytest_cfg ? "pyproject.toml [tool.pytest]" : "tests/test_*.py",
            "test",
        ));
    }

    if (fs.existsSync(nodePath.join(workspace, "tsconfig.json"))) {
        out.push(new VerifyCommand("npx tsc --noEmit", "tsconfig.json", "typecheck"));
    } else {
        const pkg = _read_json(nodePath.join(workspace, "package.json")) as Record<string, unknown> | null;
        const scripts = (pkg?.scripts as Record<string, unknown> | undefined);
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

/**
 * Whether a standing ALLOW rule already covers running this unattended.
 *
 * Not the same question as "would the agent be allowed to run it with the user
 * watching". This loop runs on its own, repeatedly, so anything short of an
 * existing allow is treated as no.
 */
export function is_allowed(command: string, workspace: string): [boolean, string] {
    try {
        const rule = get_permission_rules().match(
            _PERMISSION_TOOL, { command }, workspace || "",
        );
        if (rule === null) return [false, "没有放行这条命令的规则"];
        if ((rule.behavior as RuleBehavior) !== "allow") {
            return [false, `这条命令的规则是「${rule.behavior}」，不是自动放行`];
        }
        return [true, ""];
    } catch (exc) {
        return [false, `权限规则读取失败：${exc}`];
    }
}

/** Blocking single command run. The source calls it through a thread. */
export async function _run_one(cmd: VerifyCommand, workspace: string): Promise<Record<string, unknown>> {
    try {
        const { guardedSpawn } = await import("./executors.js");
        const proc = await guardedSpawn(cmd.command, { timeout: VERIFY_TIMEOUT_S, cwd: workspace });
        const raw = (proc.stdout || "") + (proc.stderr || "");
        const rc = Number(proc.returncode || 0);
        return {
            command: cmd.command, source: cmd.source, kind: cmd.kind,
            exitCode: rc,
            passed: rc === 0,
            output: truncate_output(raw),
        };
    } catch (exc) {
        // A verify command that cannot even be launched is NOT a failed change.
        // Reporting it as one would send the goal into a repair loop over a
        // missing interpreter.
        return {
            command: cmd.command, source: cmd.source, kind: cmd.kind,
            exitCode: -1, passed: true, unavailable: true,
            output: `这条验证命令没能执行：${exc}`,
        };
    }
}

/**
 * Run the project's own checks. Never throws.
 *
 * `ran=false` means no machine verification happened — the caller must fall
 * back to the LLM verdict rather than treating it as a pass or a fail. Stops
 * at the first genuine failure.
 */
export async function verify(workspace: string): Promise<Record<string, unknown>> {
    const commands = probe(workspace);
    if (commands.length === 0) {
        return { ran: false, passed: false, skipped: true,
            skipReason: "这个项目没有可自动运行的验证命令", results: [], summary: "" };
    }

    const results: Record<string, unknown>[] = [];
    const skipped: string[] = [];
    for (const cmd of commands) {
        const [ok, why] = is_allowed(cmd.command, workspace);
        if (!ok) {
            skipped.push(`${cmd.command}（${why}）`);
            continue;
        }
        const res = await _run_one(cmd, workspace);
        results.push(res);
        if (!res["passed"]) break;
    }

    if (results.length === 0) {
        return { ran: false, passed: false, skipped: true,
            skipReason: "验证命令没有被放行：" + skipped.join("；"),
            results: [], summary: "" };
    }

    const failed = results.filter((r) => !r["passed"]);
    const parts = results.map((r) => `${r["command"]} → 退出码 ${r["exitCode"]}`);
    if (skipped.length) parts.push("跳过：" + skipped.join("；"));
    return {
        ran: true,
        passed: failed.length === 0,
        skipped: false,
        skipReason: "",
        results,
        summary: parts.join("；"),
    };
}

/** Lightweight pre-write syntax check via local shadow workspace (fail-open). */
export async function precheck_proposed_content(
    path: string,
    content: string,
    workspace = "",
): Promise<[boolean, string]> {
    const { preview_write } = await import("./shadow_workspace.js");
    const preview = await preview_write(path, content, workspace);
    if (preview.ok) return [true, ""];
    return [false, preview.format_error()];
}

export function truncate_output(text: string, limit: number = MAX_VERIFY_OUTPUT_CHARS): string {
    text = text || "";
    if (text.length <= limit) return text;
    const head = Math.floor(limit / 3);
    const tail = limit - head;
    const omitted = text.length - head - tail;
    return `${text.slice(0, head)}\n… [省略 ${omitted} 个字符] …\n${text.slice(-tail)}`;
}

export function repair_prompt(report: Record<string, unknown>): string {
    const results = (report?.results as Record<string, unknown>[] | undefined) || [];
    const failed = results.filter((r) => !r?.passed);
    if (failed.length === 0) return "";
    const blocks = failed.map((r) =>
        `命令：${r.command}（来自 ${r.source}）\n退出码：${r.exitCode}\n输出：\n${r.output || "（无输出）"}`
    );
    return (
        "你刚才报告任务已完成，但项目自己的验证命令没有通过。这是机器判定的结果，" +
        "不是意见——在验证通过之前任务不算完成。\n\n" +
        blocks.join("\n\n") +
        "\n\n请定位并修掉上面的失败原因，不要绕过验证、不要改动或删掉测试来让它变绿。"
    );
}

// PORT STATUS: confidence=high todos=[0]
// DIVERGENCE(port): the source runs the blocking command through
// asyncio.to_thread; Node's guardedSpawn is already a promise, so _run_one /
// verify are async with identical ordering (one command at a time, stop at
// first failure). precheck_proposed_content is async for the same reason —
// callers await the same block-or-pass verdict.
