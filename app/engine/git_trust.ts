/**
 * git_trust.ts — Git repository trust checking + Conventional Commits generation.
 *
 * Ported from `app/backend/git_trust.py` (395 lines).
 *
 * RULEBOOK CITATIONS:
 * - §1 String/bytes: UTF-8 everywhere.
 * - §2 Result type preserved (Result<T> from result.ts).
 * - §2 BreakerState not applicable here; Result::ok / success / failure preserved.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { Result } from "./result.js";
import { homeDir } from "./user_dirs.js";

// ---------------------------------------------------------------------------
// Trust list path
// ---------------------------------------------------------------------------

function _trust_list_path(): string {
    return `${homeDir()}/trusted_repos.txt`;
}

// ---------------------------------------------------------------------------
// GitTrustChecker
// ---------------------------------------------------------------------------

export class GitTrustChecker {
    private _trusted_repo_hashes: Set<string> = new Set();
    private _trusted_signatures: Set<string> = new Set();

    constructor() {
        this._load_trust_list();
    }

    private _load_trust_list(): void {
        try {
            const fs = nodeFs;
            const data = fs.readFileSync(_trust_list_path(), "utf-8");
            for (const line of data.split("\n")) {
                const trimmed = line.trim();
                if (trimmed) {
                    this._trusted_repo_hashes.add(trimmed);
                }
            }
        } catch {
            // fail-open: optional enhancement
        }
    }

    private _save_trust_list(): void {
        const fs = nodeFs;
        fs.mkdirSync(homeDir(), { recursive: true });
        const content = Array.from(this._trusted_repo_hashes).join("\n") + "\n";
        fs.writeFileSync(_trust_list_path(), content);
    }

    check_repo_safe(repo_path: string): Result<string> {
        const git_dir = `${repo_path}/.git`;
        const fs = nodeFs;
        const path = nodePath;

        if (!fs.existsSync(git_dir)) {
            return Result.success("Not a Git repository, considered safe");
        }

        // Check 1: .git is not a symlink to external location
        if (fs.statSync(git_dir).isSymbolicLink?.() ?? fs.lstatSync(git_dir).isSymbolicLink()) {
            const real_path = fs.realpathSync(git_dir);
            if (!real_path.startsWith(fs.realpathSync(repo_path))) {
                return Result.failure(`Unsafe: .git is symlink to external location: ${real_path}`);
            }
        }

        // Check 2: gitdir not pointing outside
        const gitdir_file = `${git_dir}/config`;
        if (fs.existsSync(gitdir_file)) {
            const config = fs.readFileSync(gitdir_file, "utf-8");
            for (const line of config.split("\n")) {
                if (line.startsWith("worktree =") || line.startsWith("gitdir:")) {
                    const value = line.split("=")[1]?.trim() ?? "";
                    if (value.startsWith("/") || value.startsWith("\\")) {
                        return Result.failure(`Unsafe: gitdir points outside repo: ${value}`);
                    }
                }
            }
        }

        // Check 3: repo hash vs trusted list
        const repo_hash = this._calculate_repo_hash(repo_path);
        if (this._trusted_repo_hashes.has(repo_hash)) {
            return Result.success("Repository is trusted");
        }

        return Result.failure(`Repository not in trusted list. Hash: ${repo_hash.slice(0, 16)}...`);
    }

    mark_trusted(repo_path: string): Result<string> {
        const repo_hash = this._calculate_repo_hash(repo_path);
        this._trusted_repo_hashes.add(repo_hash);
        this._save_trust_list();
        return Result.success(`Repository marked as trusted: ${repo_hash.slice(0, 16)}...`);
    }

    private _calculate_repo_hash(repo_path: string): string {
        const fs = nodeFs;
        try {
            const head_hash = execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: repo_path,
                encoding: "utf-8",
                timeout: 5000,
                stdio: ["pipe", "pipe", "ignore"],
            }).trim() || "no-head";

            let config_content = "";
            const config_path = `${repo_path}/.git/config`;
            if (fs.existsSync(config_path)) {
                const buf = fs.readFileSync(config_path);
                config_content = buf.subarray(0, 1000).toString("utf-8");
            }

            const combined = `${head_hash}:${config_content}`;
            return createHash("sha256").update(combined).digest("hex");
        } catch {
            // Fallback: hash directory structure
            const files: string[] = [];
            const walk = (dir: string): void => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.name.startsWith(".")) {
                        files.push(entry.name);
                    }
                }
            };
            try { walk(repo_path); } catch { /* ignore */ }
            return createHash("sha256").update(files.sort().join("|")).digest("hex").slice(0, 32);
        }
    }
}

let _checker: GitTrustChecker | null = null;
export function get_git_trust_checker(): GitTrustChecker {
    if (_checker === null) {
        _checker = new GitTrustChecker();
    }
    return _checker;
}

// ---------------------------------------------------------------------------
// CommitMessageGenerator
// ---------------------------------------------------------------------------

export const VALID_TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "build", "ci"] as const;
const MAX_DIFF_CHARS = 12000;

type LlmCallback = (prompt: Record<string, unknown>) => string | Promise<string> | Record<string, unknown>;

export interface GeneratedCommit {
    message: string;
    type: string;
    generated_by: "llm" | "heuristic";
}

export class CommitMessageGenerator {
    private _llm: LlmCallback | null;

    constructor(llm_callback: LlmCallback | null = null) {
        this._llm = llm_callback;
    }

    /** Whether an LLM callback is configured. */
    hasLlm(): boolean {
        return this._llm !== null;
    }

    /** Set the LLM callback (used by the singleton factory). */
    setLlm(fn: LlmCallback): void {
        this._llm = fn;
    }

    private _git(repo_path: string, args: string[]): Result<string> {
        try {
            const stdout = execFileSync("git", ["-c", "core.quotePath=false", ...args], {
                cwd: repo_path,
                encoding: "utf-8",
                timeout: 15000,
                stdio: ["pipe", "pipe", "ignore"],
            });
            return Result.success(stdout);
        } catch (e) {
            return Result.failure(`git ${args.join(" ")} failed: ${e}`, { code: "GitError" });
        }
    }

    collect_staged_diff(repo_path: string, include_unstaged: boolean = false): Result<string> {
        const proc = this._git(repo_path, include_unstaged ? ["diff", "HEAD"] : ["diff", "--cached"]);
        if (!proc.ok) return proc;
        let diff = proc.value!;
        if (include_unstaged) {
            const untracked = this._git(repo_path, ["ls-files", "--others", "--exclude-standard"]);
            if (untracked.ok && untracked.value!.trim()) {
                const names = untracked.value!.split("\n").filter((n) => n.trim()).slice(0, 50);
                diff += "\n\n# 新增（未跟踪）文件:\n" + names.map((n) => `# + ${n}`).join("\n");
            }
        }
        if (!diff.trim()) {
            return Result.failure(
                include_unstaged ? "没有可提交的改动。" : "暂存区是空的，请先 git add 或勾选「包含未暂存的更改」。",
                { code: "NoStagedChanges" },
            );
        }
        if (diff.length > MAX_DIFF_CHARS) {
            diff = diff.slice(0, MAX_DIFF_CHARS) + "\n... [diff truncated]";
        }
        return Result.success(diff);
    }

    collect_recent_style(repo_path: string, count: number = 10): string[] {
        const proc = this._git(repo_path, ["log", `-${count}`, "--pretty=format:%s"]);
        if (!proc.ok || !proc.value!.trim()) return [];
        return proc.value!.split("\n").filter((ln) => ln.trim()).map((ln) => ln.trim());
    }

    async generate(
        repo_path: string,
        include_unstaged: boolean = false,
        llm_callback?: LlmCallback,
    ): Promise<Result<GeneratedCommit>> {
        const diff_r = this.collect_staged_diff(repo_path, include_unstaged);
        if (!diff_r.ok) return diff_r as unknown as Result<GeneratedCommit>;
        const diff = diff_r.value!;
        const recent = this.collect_recent_style(repo_path);

        const llm = llm_callback ?? this._llm;
        if (llm) {
            const message = await this._generate_with_llm(diff, recent, llm);
            if (message) {
                return Result.success({
                    message: this._sanitize(message),
                    type: this._extract_type(message),
                    generated_by: "llm",
                });
            }
        }

        const message = this._heuristic(repo_path, diff, include_unstaged);
        return Result.success({
            message,
            type: this._extract_type(message),
            generated_by: "heuristic",
        });
    }

    private async _generate_with_llm(diff: string, recent: string[], llm: LlmCallback): Promise<string> {
        const prompt = {
            task: "commit_message" as const,
            instruction: `Write ONE Conventional Commits message for the staged diff. Format: type(scope): description. type in ${VALID_TYPES.join(",")}. Imperative mood, <=72 char subject. Match the style of the recent commits when reasonable.`,
            recent_commits: recent,
            diff,
        };
        try {
            const out = await llm(prompt);
            if (typeof out === "object" && out !== null && "message" in out) {
                return String((out as Record<string, unknown>).message ?? "").trim();
            }
            return String(out ?? "").trim();
        } catch {
            return "";
        }
    }

    private _heuristic(repo_path: string, diff: string, include_unstaged: boolean): string {
        const path = nodePath;
        const stat = this._git(
            repo_path,
            include_unstaged ? ["diff", "HEAD", "--name-status"] : ["diff", "--cached", "--name-status"],
        );
        const files: [string, string][] = [];
        const statVal = stat.value;
        if (stat.ok && statVal) {
            for (const line of statVal.split("\n")) {
                const parts = line.split("\t");
                if (parts.length >= 2) {
                    files.push([(parts[0] ?? "").trim(), (parts[parts.length - 1] ?? "").trim()]);
                }
            }
        }
        if (include_unstaged) {
            const untracked = this._git(repo_path, ["ls-files", "--others", "--exclude-standard"]);
            const untrackedVal = untracked.value;
            if (untracked.ok && untrackedVal) {
                for (const n of untrackedVal.split("\n")) {
                    if (n.trim()) files.push(["A", n.trim()]);
                }
            }
        }

        const ctype = this._infer_type(files, diff);
        const scope = CommitMessageGenerator._infer_scope(files);
        let desc: string;
        if (files.length === 0) {
            desc = "update staged changes";
        } else if (files.length === 1) {
            desc = `update ${path.basename(files[0]?.[1] ?? "")}`;
        } else {
            desc = `update ${files.length} files`;
        }
        const scope_part = scope ? `(${scope})` : "";
        const subject = `${ctype}${scope_part}: ${desc}`.slice(0, 72);
        const body_lines = files.slice(0, 20).map(([status, p]) => `- ${status} ${p}`);
        const body = body_lines.join("\n");
        return body ? `${subject}\n\n${body}` : subject;
    }

    private _infer_type(files: [string, string][], diff: string): string {
        const paths = files.map(([, p]) => p.toLowerCase());
        if (files.length > 0 && files.every(([s]) => s === "A")) return "feat";
        if (paths.some((p) => p.includes("p") || p.endsWith("_test.py") || p.endsWith(".test.ts") || p.endsWith(".spec.ts"))) return "test";
        if (paths.some((p) => p.endsWith(".md") || p.endsWith(".rst") || p.endsWith(".txt"))) return "docs";
        if (paths.some((p) => p.endsWith(".css") || p.endsWith(".scss"))) return "style";
        if (/\bfix|bug|error|crash|patch\b/i.test(diff)) return "fix";
        if (paths.some((p) => p.includes("config") || p.endsWith(".json") || p.endsWith(".toml") || p.endsWith(".yaml") || p.endsWith(".yml") || p.endsWith(".ini"))) return "chore";
        return files.length > 0 ? "refactor" : "chore";
    }

    private static _infer_scope(files: [string, string][]): string {
        if (files.length === 0) return "";
        const tops = new Set<string>();
        for (const [, p] of files) {
            const norm = p.replace(/\\/g, "/");
            const top = norm.includes("/") ? (norm.split("/")[0] ?? "") : "";
            if (top) tops.add(top);
        }
        return tops.size === 1 ? (Array.from(tops)[0] ?? "") : "";
    }

    private _extract_type(message: string): string {
        const m = message.trim().match(/^([a-z]+)(\([^)]*\))?!?:/);
        const group1 = m?.[1] ?? "";
        if (group1 && (VALID_TYPES as readonly string[]).includes(group1)) {
            return group1;
        }
        return "chore";
    }

    private _sanitize(message: string): string {
        let text = message.trim();
        text = text.replace(/^```[a-zA-Z]*\n?/, "");
        text = text.replace(/\n?```$/, "");
        return text.trim().replace(/^"|"$/g, "").trim();
    }
}

let _commit_gen: CommitMessageGenerator | null = null;
export function get_commit_message_generator(llm_callback?: LlmCallback): CommitMessageGenerator {
    if (_commit_gen === null) {
        _commit_gen = new CommitMessageGenerator(llm_callback);
    } else if (llm_callback !== undefined && !_commit_gen.hasLlm()) {
        _commit_gen.setLlm(llm_callback);
    }
    return _commit_gen;
}

// PORT STATUS: confidence=high todos=[0]
