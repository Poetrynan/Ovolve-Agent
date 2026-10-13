/**
 * worktree_manager.ts — Git Worktree 物理隔离多代理调度管理器 (Phase 63 核心硬内化)。
 *
 * Ported bug-for-bug from `app/backend/worktree_manager.py` (179 lines, wave-10,
 * unit 221). 命名、默认值、异常类型/文案、返回元组形态、字符串处理逐条对齐；源文件
 * 自身的历史缺陷原样保留（见下），本文件零 TODO(port)。
 *
 * BUG-FOR-BUG FACTS (pinned by the w221 parity probe)
 *   1. `_run_git(args, cwd)`：argv 恒为 `["git"] + args`；subprocess.run 以
 *      **固定关键字** `cwd / capture_output=True / text=True / encoding="utf-8"
 *      / errors="ignore" / timeout=30` 调用（探针把整张 opts 记进账本钉死）。
 *      成功返回 `(returncode, stdout.strip(), stderr.strip())`——`.strip()` 用
 *      **CPython 码点空白集**（含 \x1c-\x1f \u0085 \u00a0 \u1680 \u2000-\u200a
 *      \u2028 \u2029 \u202f \u205f \u3000，**不含** \ufeff）。任何异常（含
 *      TimeoutExpired）→ `except Exception` 臂返回 `(-1, "", str(exc))`。
 *   2. `is_git_repo(root_dir)`：`if not root_dir or not os.path.exists(root_dir):
 *      return False`——空串 / None / 0 / [] / {} / False 一律 **短路** 在 exists
 *      之前返回 False；`_run_git(["rev-parse","--is-inside-work-tree"])` 判定
 *      `code == 0 and out == "true"`（大小写敏感，"True"/"1"/"TRUE" 全 False）。
 *   3. `create_isolated_worktree(root_dir, branch_name, base_ref="HEAD")`：
 *      非仓库 → `(False, "", f"Target directory '{root_dir}' is not a valid Git
 *      repository.")`。路径规范化用 **win32 ntpath.join** 两段：
 *      `worktrees_base = join(root_dir, ".worktrees")` → `makedirs(exist_ok=True)`
 *      → `worktree_path = join(worktrees_base, branch_name)`。若 `exists(worktree_path)`：
 *      先 `git worktree remove --force`，**再次** `exists` 仍为真才 `shutil.rmtree
 *      (ignore_errors=True)`（remove 成功即不再 rmtree）。`show-ref --verify
 *      refs/heads/<branch>` rc==0 → 直接挂载 `worktree add <path> <branch>`，否则
 *      新建分支 `worktree add -b <branch> <path> <base_ref>`。`worktree add` rc!=0 →
 *      `(False, "", f"Failed to create git worktree: {stderr or stdout}")`（`or` 取
 *      **第一个真值操作数本身**）。成功打 `log.info` 并返回三元组。
 *   4. `cleanup_worktree(root_dir, worktree_path, branch_name="", delete_branch=True)`：
 *      非仓库 → `(False, f"Not a git repo: {root_dir}")`。步骤固定：`worktree remove
 *      --force` →（exists 则 rmtree）→ `worktree prune` → `if delete_branch and
 *      branch_name: branch -D`。返回值**永远忽略**这些 git 的 rc（源文件不检查
 *      cleanup 里任何 git 命令的返回码——保留该缺陷）。总是 `(True, f"Cleaned up
 *      worktree '{worktree_path}'.")`。
 *   5. `merge_worktree_branch(root_dir, branch_name, target_branch="main")`：
 *      非仓库 → `(False, f"Not a git repo: {root_dir}")`。`merge --no-ff <branch> -m
 *      "chore: merge subagent worktree branch '<branch>'"` rc!=0 → **先** `merge --abort`
 *      再返回 `(False, f"Merge conflict detected when merging '{branch}': {stderr or stdout}")`。
 *      成功返回文案写死 "into target branch."——`target_branch` 参数**从未参与任何
 *      git 命令或文案**（源文件缺陷，保留：merge 永远合到当前 HEAD 而非 target_branch）。
 *   6. `list_active_worktrees(root_dir)`：非仓库 → `[]`；`worktree list --porcelain`
 *      `rc != 0 or not stdout` → `[]`（stdout 为**已 strip** 的字符串）。逐行
 *      `stdout.splitlines()`（CPython 断行集，\x1f **不**断行、\r\n 当一个），每行
 *      先 `.strip()`；空行提交当前 dict 并重置；`worktree `/`HEAD `/`branch ` 前缀
 *      用 `split(" ",1)[1]` 取值（branch 再 `.replace("refs/heads/","")` **全量**
 *      替换），`== "bare"` 精确匹配置 `bare=True`；**其余前缀行整体丢弃**。循环外
 *      `if current: append` 收尾（末尾无空行也能提交最后一个 dict）。
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   DIVERGENCE(port, subprocess → seam): 源文件所有 git 调用都汇聚到唯一
 *     `subprocess.run` 站点。端口把该站点抽成 `WM_SEAMS.runGitProcess(argv, opts)`，
 *     默认实现做真 spawnSync（生产路径），探针一律替换为**记录型假件**——红线 5
 *     禁止真 git / 真子进程 / 真仓库状态变更。argv 与 opts（含 cwd/capture_output/
 *     text/encoding/errors/timeout 六项，按源文件顺序）都进账本，保证端口确实以
 *     源文件相同的关键字与值发起子进程。
 *   DIVERGENCE(port, fs → seam): `os.path.exists` / `os.makedirs(exist_ok=True)` /
 *     `shutil.rmtree(ignore_errors=True)` 抽为 `WM_SEAMS.pathExists/makedirs/rmtree`，
 *     默认走真 fs，探针替换为内存假文件系统（一个路径集合 + 记账），两侧同一张
 *     场景表驱动。`os.makedirs(exist_ok=True)` 语义 = 递归且幂等；`shutil.rmtree
 *     (ignore_errors=True)` = 递归删除且吞所有错误——探针里退化为集合删除，错误面
 *     不可观察（源文件本就 ignore_errors）。
 *   DIVERGENCE(port, os.path.join → ntpath): 目标平台 win32，`os.path.join` 是
 *     CPython 3.13 `ntpath.join` + `splitroot` 的逐行移植（沿用 red_team_patrol
 *     已验证实现：盘符 / UNC / `C:` 驱动器相对不插分隔符、第二段绝对路径整体替换），
 *     分隔符硬编码 `\\` 不跟随宿主 `path.sep`。join 结果写进 worktree_path 账本行
 *     钉死；py 侧用真 `os.path.join`，ts 侧用 ntpJoin，两侧必须逐字节一致。
 *   DIVERGENCE(port, str 原语): `str.strip()` 用 CPython 码点空白集（同 fact 1）；
 *     `str.splitlines()` 断行集含 \x0b\x0c\x1c\x1d\x1e\u0085\u2028\u2029 且 \x1f
 *     **不**断行、\r\n 当一个；`line.split(" ",1)` 只在**第一个**空格处切一次
 *     （JS `split(" ",2)` 语义不同，另写 `pySplitSpace1`）；`.replace("refs/heads/",
 *     "")` 全量替换用 `replaceAll`。
 *   DIVERGENCE(port, tuple → array): python 的 `tuple[int,str,str]` 端口用
 *     `[number,string,string]` 表示，JSON 序列化为数组——两侧探针的 ret 编码一致。
 *   DIVERGENCE(port, str(exc)): `except Exception as exc: ... str(exc)`——端口
 *     `pyStr(error)` 返回 `error.message`（CPython `str(Exception("m"))=="m"` 同）。
 *     探针在 raise 脚本里喂受控文案，保证两侧 `str(exc)` 逐字相同。
 *   DIVERGENCE(port, logging): `log.info(fmt, *args)` 的 **% 惰性格式**：fmt 与
 *     args 分开交给 seam，不预渲染；未渲染的参数就是探针要钉的形态。
 *   DIVERGENCE(port, import os.environ): 源文件 import os 但模块加载期**不读**
 *     os.environ/getenv（见探针 env 判定），故本单元无 import 期环境变量面。
 */

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

// ── python-semantics helpers (house style: file-local) ───────────────────────

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    if (v instanceof Set) return "set";
    if (typeof v === "function") return "function";
    if (v instanceof Error) return v.name;
    if (isPyDict(v) || v instanceof Map) return "dict";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        if (ctor && ctor.name && ctor.name !== "Object") return ctor.name;
        return "object";
    }
    return typeof v;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Set || v instanceof Map) return v.size > 0;
    if (isPyDict(v)) return Object.keys(v).length > 0;
    return true;
}

function isPyDict(v: unknown): v is Record<string, unknown> {
    if (typeof v !== "object" || v === null || Array.isArray(v)
        || v instanceof Error || v instanceof Map || v instanceof Set) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/** python `str(x)`（f-string 与 str(exc) 共用；本模块可能出现的值形态）。 */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.message;
    return String(v);
}

/** CPython str.strip() 的空白集（码点）；注意 **不含** U+FEFF。 */
const PY_WS = new Set<number>([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
    0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
    0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
function pyStrip(s: string): string {
    const a = Array.from(s);
    let i = 0;
    let j = a.length;
    while (i < j && PY_WS.has((a[i] as string).codePointAt(0) as number)) i++;
    while (j > i && PY_WS.has((a[j - 1] as string).codePointAt(0) as number)) j--;
    return a.slice(i, j).join("");
}

/** CPython str.splitlines()：\x1f **不是**断行；\r\n 当一个；末尾断行不产生空尾行。 */
const LINE_BOUNDARIES = new Set<string>([
    "\n", "\v", "\f", "\r", "\x1c", "\x1d", "\x1e", "\u0085", "\u2028", "\u2029",
]);
function pySplitlines(s: string): string[] {
    const out: string[] = [];
    let cur = "";
    const chars = Array.from(s);
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] as string;
        if (ch === "\r") {
            out.push(cur);
            cur = "";
            if (chars[i + 1] === "\n") i++;
            continue;
        }
        if (LINE_BOUNDARIES.has(ch)) {
            out.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    if (cur !== "") out.push(cur);
    return out;
}

/** python `s.split(" ", 1)`：只在第一个空格处切一次（JS split(sep,limit) 语义不同）。 */
function pySplitSpace1(s: string): string[] {
    const i = s.indexOf(" ");
    if (i < 0) return [s];
    return [s.slice(0, i), s.slice(i + 1)];
}

/** python `x or y`（取第一个真值操作数**本身**）。 */
function pyOr<T>(v: T, fallback: T): T {
    return pyTruth(v) ? v : fallback;
}

// ── ntpath.join / splitroot（CPython 3.13 Lib/ntpath.py 的逐行移植）──────────

const NTP_SEP = "\\";
const NTP_SEPS = "\\/";
const NTP_COLON_SEPS = ":\\/";

type SplitRoot = [string, string, string];

function ntpSplitroot(p: string): SplitRoot {
    const uncPrefix = "\\\\?\\UNC\\";
    const empty = "";
    const normp = p.split("/").join(NTP_SEP);
    if (normp.slice(0, 1) === NTP_SEP) {
        if (normp.slice(1, 2) === NTP_SEP) {
            const start = normp.slice(0, 8).toUpperCase() === uncPrefix ? 8 : 2;
            const index = normp.indexOf(NTP_SEP, start);
            if (index === -1) return [p, empty, empty];
            const index2 = normp.indexOf(NTP_SEP, index + 1);
            if (index2 === -1) return [p, empty, empty];
            return [p.slice(0, index2), p.slice(index2, index2 + 1), p.slice(index2 + 1)];
        }
        return [empty, p.slice(0, 1), p.slice(1)];
    }
    if (normp.slice(1, 2) === ":") {
        if (normp.slice(2, 3) === NTP_SEP) {
            return [p.slice(0, 2), p.slice(2, 3), p.slice(3)];
        }
        return [p.slice(0, 2), empty, p.slice(2)];
    }
    return [empty, empty, p];
}

/** python `os.path.join(a, b)`（win32 ntpath；本模块只有二元调用）。 */
function ntpJoin(a: unknown, b: string): string {
    if (typeof a !== "string") {
        if (a instanceof Uint8Array) {
            throw new TypeErrorP("Can't mix strings and bytes in path components");
        }
        throw new TypeErrorP(`expected str, bytes or os.PathLike object, not ${pyTypeName(a)}`);
    }
    let [resultDrive, resultRoot, resultPath] = ntpSplitroot(a);
    const [pDrive, pRoot, pPath] = ntpSplitroot(b);
    if (pRoot) {
        if (pDrive || !resultDrive) resultDrive = pDrive;
        resultRoot = pRoot;
        resultPath = pPath;
    } else if (pDrive && pDrive !== resultDrive) {
        if (pDrive.toLowerCase() !== resultDrive.toLowerCase()) {
            resultDrive = pDrive;
            resultRoot = pRoot;
            resultPath = pPath;
        } else {
            resultDrive = pDrive;
        }
    } else {
        if (resultPath && !NTP_SEPS.includes(resultPath.slice(-1))) {
            resultPath = resultPath + NTP_SEP;
        }
        resultPath = resultPath + pPath;
    }
    if (resultPath && !resultRoot && resultDrive
        && !NTP_COLON_SEPS.includes(resultDrive.slice(-1))) {
        return resultDrive + NTP_SEP + resultPath;
    }
    return resultDrive + resultRoot + resultPath;
}

// ── seams（测试注入面；默认实现 = 生产行为）─────────────────────────────────

/** 与 python `subprocess.CompletedProcess` 对齐的最小返回面。 */
export type GitResult = { returncode: number; stdout: string; stderr: string };

export const WM_SEAMS = {
    /**
     * python `subprocess.run(argv, cwd=..., capture_output=True, text=True,
     * encoding="utf-8", errors="ignore", timeout=30)`。opts 逐字携带源文件的六项
     * 关键字（探针记账核对）。默认实现：真 spawnSync（**仅生产路径**，探针必替换）。
     */
    runGitProcess(argv: string[], opts: Record<string, unknown>): GitResult {
        const r = spawnSync(argv[0] as string, argv.slice(1), {
            cwd: opts.cwd as string | undefined,
            encoding: "utf-8",
            timeout: opts.timeout as number | undefined,
            windowsHide: true,
        });
        if (r.error) throw r.error;
        return {
            returncode: r.status === null ? -1 : r.status,
            stdout: typeof r.stdout === "string" ? r.stdout : "",
            stderr: typeof r.stderr === "string" ? r.stderr : "",
        };
    },
    /** python `os.path.exists(p)`。 */
    pathExists(p: string): boolean {
        return fs.existsSync(p);
    },
    /** python `os.makedirs(p, exist_ok=True)`。 */
    makedirs(p: string): void {
        fs.mkdirSync(p, { recursive: true });
    },
    /** python `shutil.rmtree(p, ignore_errors=True)`。 */
    rmtree(p: string): void {
        fs.rmSync(p, { recursive: true, force: true });
    },
    /** python `log.info(fmt, *args)` / `log.warning(...)`——% 惰性格式，不预渲染。 */
    log(level: string, fmt: string, args: unknown[]): void {
        if (level === "warning") {
            console.error(`worktree_manager: ${fmt} ${JSON.stringify(args)}`);
        }
    },
};

// ── WorktreeManager ──────────────────────────────────────────────────────────

/** 生产级 Git Worktree 临时沙盒与生命周期管理器。 */
export class WorktreeManager {
    /** 执行底层 git 命令并捕获返回码与标准输出。 */
    static _run_git(args: string[], cwd: unknown): [number, string, string] {
        try {
            const res = WM_SEAMS.runGitProcess(["git"].concat(args), {
                cwd,
                capture_output: true,
                text: true,
                encoding: "utf-8",
                errors: "ignore",
                timeout: 30,
            });
            return [res.returncode, pyStrip(res.stdout), pyStrip(res.stderr)];
        } catch (exc: unknown) {
            return [-1, "", pyStr(exc)];
        }
    }

    /** 检查指定目录是否为合法的 Git 仓库。 */
    static is_git_repo(root_dir: unknown): boolean {
        if (!pyTruth(root_dir) || !WM_SEAMS.pathExists(root_dir as string)) {
            return false;
        }
        const [code, out] = WorktreeManager._run_git(
            ["rev-parse", "--is-inside-work-tree"], root_dir);
        return code === 0 && out === "true";
    }

    /** 创建独立的物理临时 Git Worktree 工作区。 */
    static create_isolated_worktree(
        root_dir: unknown,
        branch_name: string,
        base_ref: string = "HEAD",
    ): [boolean, string, string] {
        if (!WorktreeManager.is_git_repo(root_dir)) {
            return [false, "",
                `Target directory '${pyStr(root_dir)}' is not a valid Git repository.`];
        }

        const worktrees_base = ntpJoin(root_dir, ".worktrees");
        WM_SEAMS.makedirs(worktrees_base);
        const worktree_path = ntpJoin(worktrees_base, branch_name);

        if (WM_SEAMS.pathExists(worktree_path)) {
            WorktreeManager._run_git(
                ["worktree", "remove", "--force", worktree_path], root_dir);
            if (WM_SEAMS.pathExists(worktree_path)) {
                WM_SEAMS.rmtree(worktree_path);
            }
        }

        const [code] = WorktreeManager._run_git(
            ["show-ref", "--verify", `refs/heads/${branch_name}`], root_dir);
        let add_args: string[];
        if (code === 0) {
            add_args = ["worktree", "add", worktree_path, branch_name];
        } else {
            add_args = ["worktree", "add", "-b", branch_name, worktree_path, base_ref];
        }

        const [rc, stdout, stderr] = WorktreeManager._run_git(add_args, root_dir);
        if (rc !== 0) {
            return [false, "",
                `Failed to create git worktree: ${pyOr(stderr, stdout)}`];
        }

        WM_SEAMS.log("info",
            "[WorktreeManager] Created isolated worktree at %s (branch: %s)",
            [worktree_path, branch_name]);
        return [true, worktree_path,
            `Isolated worktree created at '${worktree_path}' on branch '${branch_name}'.`];
    }

    /** 物理销毁临时工作区并清理分支。 */
    static cleanup_worktree(
        root_dir: unknown,
        worktree_path: string,
        branch_name: string = "",
        delete_branch: boolean = true,
    ): [boolean, string] {
        if (!WorktreeManager.is_git_repo(root_dir)) {
            return [false, `Not a git repo: ${pyStr(root_dir)}`];
        }

        // 1. git worktree remove
        WorktreeManager._run_git(
            ["worktree", "remove", "--force", worktree_path], root_dir);

        // 2. 物理兜底清理
        if (WM_SEAMS.pathExists(worktree_path)) {
            WM_SEAMS.rmtree(worktree_path);
        }

        // 3. 运行 prune 清理工作区引用
        WorktreeManager._run_git(["worktree", "prune"], root_dir);

        // 4. 删除临时分支
        if (delete_branch && branch_name) {
            WorktreeManager._run_git(["branch", "-D", branch_name], root_dir);
        }

        WM_SEAMS.log("info",
            "[WorktreeManager] Cleaned up worktree at %s", [worktree_path]);
        return [true, `Cleaned up worktree '${worktree_path}'.`];
    }

    /** 将子代理临时分支安全合并回目标主分支。 */
    static merge_worktree_branch(
        root_dir: unknown,
        branch_name: string,
        target_branch: string = "main",
    ): [boolean, string] {
        if (!WorktreeManager.is_git_repo(root_dir)) {
            return [false, `Not a git repo: ${pyStr(root_dir)}`];
        }

        // 确保在主工作区执行 merge
        const [rc, stdout, stderr] = WorktreeManager._run_git(
            ["merge", "--no-ff", branch_name, "-m",
                `chore: merge subagent worktree branch '${branch_name}'`], root_dir);
        if (rc !== 0) {
            // 冲突时自动回滚合并，杜绝脏状态
            WorktreeManager._run_git(["merge", "--abort"], root_dir);
            return [false,
                `Merge conflict detected when merging '${branch_name}': ${pyOr(stderr, stdout)}`];
        }

        // DIVERGENCE/BUG 保留：target_branch 参数从不参与 git 命令或文案（源缺陷）。
        void target_branch;
        return [true, `Successfully merged branch '${branch_name}' into target branch.`];
    }

    /** 列出当前仓库所有活跃的 Git Worktrees。 */
    static list_active_worktrees(root_dir: unknown): Record<string, unknown>[] {
        if (!WorktreeManager.is_git_repo(root_dir)) {
            return [];
        }

        const [rc, stdout] = WorktreeManager._run_git(
            ["worktree", "list", "--porcelain"], root_dir);
        if (rc !== 0 || !pyTruth(stdout)) {
            return [];
        }

        const worktrees: Record<string, unknown>[] = [];
        let current: Record<string, unknown> = {};
        for (const rawLine of pySplitlines(stdout)) {
            const line = pyStrip(rawLine);
            if (!pyTruth(line)) {
                if (pyTruth(current)) {
                    worktrees.push(current);
                    current = {};
                }
                continue;
            }
            if (line.startsWith("worktree ")) {
                current["path"] = pySplitSpace1(line)[1] as string;
            } else if (line.startsWith("HEAD ")) {
                current["head"] = pySplitSpace1(line)[1] as string;
            } else if (line.startsWith("branch ")) {
                current["branch"] = (pySplitSpace1(line)[1] as string).replaceAll("refs/heads/", "");
            } else if (line === "bare") {
                current["bare"] = true;
            }
        }

        if (pyTruth(current)) {
            worktrees.push(current);
        }

        return worktrees;
    }
}

// PORT STATUS: 本文件无 TODO(port)。
