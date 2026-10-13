"use strict";
/**
 * git_trust.ts 鈥?Git repository trust checking + Conventional Commits generation.
 *
 * Ported from `app/backend/git_trust.py` (395 lines).
 *
 * RULEBOOK CITATIONS:
 * - 搂1 String/bytes: UTF-8 everywhere.
 * - 搂2 Result type preserved (Result<T> from result.ts).
 * - 搂2 BreakerState not applicable here; Result::ok / success / failure preserved.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommitMessageGenerator = exports.VALID_TYPES = exports.GitTrustChecker = void 0;
exports.get_git_trust_checker = get_git_trust_checker;
exports.get_commit_message_generator = get_commit_message_generator;
const node_crypto_1 = require("node:crypto");
const node_child_process_1 = require("node:child_process");
const result_js_1 = require("./result.cjs");
const user_dirs_js_1 = require("./user_dirs.cjs");
// ---------------------------------------------------------------------------
// Trust list path
// ---------------------------------------------------------------------------
function _trust_list_path() {
    return `${(0, user_dirs_js_1.homeDir)()}/trusted_repos.txt`;
}
// ---------------------------------------------------------------------------
// GitTrustChecker
// ---------------------------------------------------------------------------
class GitTrustChecker {
    _trusted_repo_hashes = new Set();
    _trusted_signatures = new Set();
    constructor() {
        this._load_trust_list();
    }
    _load_trust_list() {
        try {
            const fs = require("node:fs");
            const data = fs.readFileSync(_trust_list_path(), "utf-8");
            for (const line of data.split("\n")) {
                const trimmed = line.trim();
                if (trimmed) {
                    this._trusted_repo_hashes.add(trimmed);
                }
            }
        }
        catch {
            // fail-open: optional enhancement
        }
    }
    _save_trust_list() {
        const fs = require("node:fs");
        fs.mkdirSync((0, user_dirs_js_1.homeDir)(), { recursive: true });
        const content = Array.from(this._trusted_repo_hashes).join("\n") + "\n";
        fs.writeFileSync(_trust_list_path(), content);
    }
    check_repo_safe(repo_path) {
        const git_dir = `${repo_path}/.git`;
        const fs = require("node:fs");
        const path = require("node:path");
        if (!fs.existsSync(git_dir)) {
            return result_js_1.Result.success("Not a Git repository, considered safe");
        }
        // Check 1: .git is not a symlink to external location
        if (fs.statSync(git_dir).isSymbolicLink?.() ?? fs.lstatSync(git_dir).isSymbolicLink()) {
            const real_path = fs.realpathSync(git_dir);
            if (!real_path.startsWith(fs.realpathSync(repo_path))) {
                return result_js_1.Result.failure(`Unsafe: .git is symlink to external location: ${real_path}`);
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
                        return result_js_1.Result.failure(`Unsafe: gitdir points outside repo: ${value}`);
                    }
                }
            }
        }
        // Check 3: repo hash vs trusted list
        const repo_hash = this._calculate_repo_hash(repo_path);
        if (this._trusted_repo_hashes.has(repo_hash)) {
            return result_js_1.Result.success("Repository is trusted");
        }
        return result_js_1.Result.failure(`Repository not in trusted list. Hash: ${repo_hash.slice(0, 16)}...`);
    }
    mark_trusted(repo_path) {
        const repo_hash = this._calculate_repo_hash(repo_path);
        this._trusted_repo_hashes.add(repo_hash);
        this._save_trust_list();
        return result_js_1.Result.success(`Repository marked as trusted: ${repo_hash.slice(0, 16)}...`);
    }
    _calculate_repo_hash(repo_path) {
        const fs = require("node:fs");
        try {
            const head_hash = (0, node_child_process_1.execFileSync)("git", ["rev-parse", "HEAD"], {
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
            return (0, node_crypto_1.createHash)("sha256").update(combined).digest("hex");
        }
        catch {
            // Fallback: hash directory structure
            const files = [];
            const walk = (dir) => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.name.startsWith(".")) {
                        files.push(entry.name);
                    }
                }
            };
            try {
                walk(repo_path);
            }
            catch { /* ignore */ }
            return (0, node_crypto_1.createHash)("sha256").update(files.sort().join("|")).digest("hex").slice(0, 32);
        }
    }
}
exports.GitTrustChecker = GitTrustChecker;
let _checker = null;
function get_git_trust_checker() {
    if (_checker === null) {
        _checker = new GitTrustChecker();
    }
    return _checker;
}
// ---------------------------------------------------------------------------
// CommitMessageGenerator
// ---------------------------------------------------------------------------
exports.VALID_TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "build", "ci"];
const MAX_DIFF_CHARS = 12000;
class CommitMessageGenerator {
    _llm;
    constructor(llm_callback = null) {
        this._llm = llm_callback;
    }
    /** Whether an LLM callback is configured. */
    hasLlm() {
        return this._llm !== null;
    }
    /** Set the LLM callback (used by the singleton factory). */
    setLlm(fn) {
        this._llm = fn;
    }
    _git(repo_path, args) {
        try {
            const stdout = (0, node_child_process_1.execFileSync)("git", ["-c", "core.quotePath=false", ...args], {
                cwd: repo_path,
                encoding: "utf-8",
                timeout: 15000,
                stdio: ["pipe", "pipe", "ignore"],
            });
            return result_js_1.Result.success(stdout);
        }
        catch (e) {
            return result_js_1.Result.failure(`git ${args.join(" ")} failed: ${e}`, { code: "GitError" });
        }
    }
    collect_staged_diff(repo_path, include_unstaged = false) {
        const proc = this._git(repo_path, include_unstaged ? ["diff", "HEAD"] : ["diff", "--cached"]);
        if (!proc.ok)
            return proc;
        let diff = proc.value;
        if (include_unstaged) {
            const untracked = this._git(repo_path, ["ls-files", "--others", "--exclude-standard"]);
            if (untracked.ok && untracked.value.trim()) {
                const names = untracked.value.split("\n").filter((n) => n.trim()).slice(0, 50);
                diff += "\n\n# 鏂板锛堟湭璺熻釜锛夋枃浠?\n" + names.map((n) => `# + ${n}`).join("\n");
            }
        }
        if (!diff.trim()) {
            return result_js_1.Result.failure(include_unstaged ? "娌℃湁鍙彁浜ょ殑鏀瑰姩銆? : "鏆傚瓨鍖烘槸绌虹殑锛岃鍏?git add 鎴栧嬀閫夈€屽寘鍚湭鏆傚瓨鐨勬洿鏀广€嶃€?, { code: "NoStagedChanges" });
        }
        if (diff.length > MAX_DIFF_CHARS) {
            diff = diff.slice(0, MAX_DIFF_CHARS) + "\n... [diff truncated]";
        }
        return result_js_1.Result.success(diff);
    }
    collect_recent_style(repo_path, count = 10) {
        const proc = this._git(repo_path, ["log", `-${count}`, "--pretty=format:%s"]);
        if (!proc.ok || !proc.value.trim())
            return [];
        return proc.value.split("\n").filter((ln) => ln.trim()).map((ln) => ln.trim());
    }
    async generate(repo_path, include_unstaged = false, llm_callback) {
        const diff_r = this.collect_staged_diff(repo_path, include_unstaged);
        if (!diff_r.ok)
            return diff_r;
        const diff = diff_r.value;
        const recent = this.collect_recent_style(repo_path);
        const llm = llm_callback ?? this._llm;
        if (llm) {
            const message = await this._generate_with_llm(diff, recent, llm);
            if (message) {
                return result_js_1.Result.success({
                    message: this._sanitize(message),
                    type: this._extract_type(message),
                    generated_by: "llm",
                });
            }
        }
        const message = this._heuristic(repo_path, diff, include_unstaged);
        return result_js_1.Result.success({
            message,
            type: this._extract_type(message),
            generated_by: "heuristic",
        });
    }
    async _generate_with_llm(diff, recent, llm) {
        const prompt = {
            task: "commit_message",
            instruction: `Write ONE Conventional Commits message for the staged diff. Format: type(scope): description. type in ${exports.VALID_TYPES.join(",")}. Imperative mood, <=72 char subject. Match the style of the recent commits when reasonable.`,
            recent_commits: recent,
            diff,
        };
        try {
            const out = await llm(prompt);
            if (typeof out === "object" && out !== null && "message" in out) {
                return String(out.message ?? "").trim();
            }
            return String(out ?? "").trim();
        }
        catch {
            return "";
        }
    }
    _heuristic(repo_path, diff, include_unstaged) {
        const path = require("node:path");
        const stat = this._git(repo_path, include_unstaged ? ["diff", "HEAD", "--name-status"] : ["diff", "--cached", "--name-status"]);
        const files = [];
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
                    if (n.trim())
                        files.push(["A", n.trim()]);
                }
            }
        }
        const ctype = this._infer_type(files, diff);
        const scope = CommitMessageGenerator._infer_scope(files);
        let desc;
        if (files.length === 0) {
            desc = "update staged changes";
        }
        else if (files.length === 1) {
            desc = `update ${path.basename(files[0]?.[1] ?? "")}`;
        }
        else {
            desc = `update ${files.length} files`;
        }
        const scope_part = scope ? `(${scope})` : "";
        const subject = `${ctype}${scope_part}: ${desc}`.slice(0, 72);
        const body_lines = files.slice(0, 20).map(([status, p]) => `- ${status} ${p}`);
        const body = body_lines.join("\n");
        return body ? `${subject}\n\n${body}` : subject;
    }
    _infer_type(files, diff) {
        const paths = files.map(([, p]) => p.toLowerCase());
        if (files.length > 0 && files.every(([s]) => s === "A"))
            return "feat";
        if (paths.some((p) => p.includes("p") || p.endsWith("_test.py") || p.endsWith(".test.ts") || p.endsWith(".spec.ts")))
            return "test";
        if (paths.some((p) => p.endsWith(".md") || p.endsWith(".rst") || p.endsWith(".txt")))
            return "docs";
        if (paths.some((p) => p.endsWith(".css") || p.endsWith(".scss")))
            return "style";
        if (/\bfix|bug|error|crash|patch\b/i.test(diff))
            return "fix";
        if (paths.some((p) => p.includes("config") || p.endsWith(".json") || p.endsWith(".toml") || p.endsWith(".yaml") || p.endsWith(".yml") || p.endsWith(".ini")))
            return "chore";
        return files.length > 0 ? "refactor" : "chore";
    }
    static _infer_scope(files) {
        if (files.length === 0)
            return "";
        const tops = new Set();
        for (const [, p] of files) {
            const norm = p.replace(/\\/g, "/");
            const top = norm.includes("/") ? (norm.split("/")[0] ?? "") : "";
            if (top)
                tops.add(top);
        }
        return tops.size === 1 ? (Array.from(tops)[0] ?? "") : "";
    }
    _extract_type(message) {
        const m = message.trim().match(/^([a-z]+)(\([^)]*\))?!?:/);
        const group1 = m?.[1] ?? "";
        if (group1 && exports.VALID_TYPES.includes(group1)) {
            return group1;
        }
        return "chore";
    }
    _sanitize(message) {
        let text = message.trim();
        text = text.replace(/^```[a-zA-Z]*\n?/, "");
        text = text.replace(/\n?```$/, "");
        return text.trim().replace(/^"|"$/g, "").trim();
    }
}
exports.CommitMessageGenerator = CommitMessageGenerator;
let _commit_gen = null;
function get_commit_message_generator(llm_callback) {
    if (_commit_gen === null) {
        _commit_gen = new CommitMessageGenerator(llm_callback);
    }
    else if (llm_callback !== undefined && !_commit_gen.hasLlm()) {
        _commit_gen.setLlm(llm_callback);
    }
    return _commit_gen;
}
// PORT STATUS: confidence=high todos=[0]
