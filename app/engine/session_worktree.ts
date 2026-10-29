/**
 * session_worktree.ts — one git worktree and one branch per conversation.
 *
 * A conversation that owns a copy stores its path in `sessions.workspace`, so
 * every tool, git route and subagent inherits the isolation without knowing
 * this module exists. Only the lifecycle lives here: create, inspect, merge
 * back, dispose.
 *
 * The copy is a SIBLING of the repository, never a child. Inside the repo it
 * would show up in the user's own `git status`, in their file search, and in
 * every other conversation's diff for as long as the parallel task lives.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/** What a session row needs to remember about its isolated tree. */
export interface WorktreeMeta {
  /** Main working tree — the folder the user actually opened. */
  repo: string;
  /** The isolated working tree this session edits. */
  path: string;
  /** Branch created for this session; the merge-back source. */
  branch: string;
  /** Branch (or commit) the copy was forked from; the merge-back target. */
  base: string;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const BRANCH_PREFIX = "ovolve/";

/**
 * Run git without a shell. A file named after a branch must never be able to
 * turn into an argument, so callers validate ref names before this is reached
 * and every flag this module passes is a literal.
 */
export function git(cwd: string, args: string[], timeout_s = 60): GitResult {
  try {
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: Math.max(1, timeout_s) * 1000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (r.error) {
      const why = (r.error as { message?: string }).message ?? String(r.error);
      return { code: -1, stdout: "", stderr: why };
    }
    return {
      code: r.status === null ? -1 : r.status,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    };
  } catch (exc) {
    const why = (exc as { message?: string })?.message ?? String(exc);
    return { code: -1, stdout: "", stderr: why };
  }
}

function is_dir(p: string): boolean {
  try {
    return Boolean(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Case-folded key: git prints forward slashes and mixed case on Windows. */
function path_key(p: string): string {
  try {
    const k = path.resolve(p);
    return process.platform === "win32" ? k.toLowerCase() : k;
  } catch {
    return p;
  }
}

/** True when `target` sits strictly below `root`. Guards every destructive path. */
function inside(root: string, target: string): boolean {
  if (!root || !target) return false;
  try {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Where all copies of this repository live: `<parent>/<name>.worktrees`. */
export function worktrees_root(repo: string): string {
  const resolved = path.resolve(repo);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}.worktrees`);
}

function slugify(raw: string): string {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return cleaned || "chat";
}

export async function repo_toplevel(dir: string): Promise<string | null> {
  if (!is_dir(dir)) return null;
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) return null;
  const top = r.stdout.trim();
  return top ? path.resolve(top) : null;
}

/**
 * A linked worktree resolves `--git-dir` to `<repo>/.git/worktrees/<name>` while
 * `--git-common-dir` stays at `<repo>/.git`. Nesting another copy inside one is
 * legal to git but nonsense to a user, so creation is refused there.
 */
export async function is_linked_worktree(dir: string): Promise<boolean> {
  const gd = git(dir, ["rev-parse", "--git-dir"]);
  const cd = git(dir, ["rev-parse", "--git-common-dir"]);
  if (gd.code !== 0 || cd.code !== 0) return false;
  const a = path.resolve(dir, gd.stdout.trim());
  const b = path.resolve(dir, cd.stdout.trim());
  return path_key(a) !== path_key(b);
}

export async function current_branch(dir: string): Promise<string> {
  const r = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

export async function branch_exists(dir: string, branch: string): Promise<boolean> {
  if (!branch) return false;
  const r = git(dir, ["show-ref", "--verify", `refs/heads/${branch}`]);
  return r.code === 0;
}

/** Which multi-step operation the repository is sitting in the middle of. */
export interface RepoOperationState {
  merging: boolean;
  rebasing: boolean;
  cherryPicking: boolean;
  reverting: boolean;
  bisecting: boolean;
}

const OPERATION_MARKERS: Array<[keyof RepoOperationState, string[]]> = [
  ["merging", ["MERGE_HEAD"]],
  ["rebasing", ["rebase-merge", "rebase-apply"]],
  ["cherryPicking", ["CHERRY_PICK_HEAD"]],
  ["reverting", ["REVERT_HEAD"]],
  ["bisecting", ["BISECT_LOG"]],
];

/**
 * Read git's own bookkeeping files rather than parsing `status` output.
 *
 * `--git-common-dir` matters: inside a copy the per-checkout state lives in
 * `.git/worktrees/<name>/`, while an operation started in the main tree lives
 * in `.git/`. Merging touches the main tree, so that is the one we ask about.
 */
export async function repo_operation_state(repo: string): Promise<RepoOperationState> {
  const state: RepoOperationState = {
    merging: false,
    rebasing: false,
    cherryPicking: false,
    reverting: false,
    bisecting: false,
  };
  if (!repo || !is_dir(repo)) return state;
  const gd = git(repo, ["rev-parse", "--git-common-dir"]);
  if (gd.code !== 0) return state;
  const dir = path.resolve(repo, gd.stdout.trim());
  for (const [key, markers] of OPERATION_MARKERS) {
    state[key] = markers.some((m) => fs.existsSync(path.join(dir, m)));
  }
  return state;
}

export function operation_state_label(st: RepoOperationState): string {
  if (st.merging) return "合并";
  if (st.rebasing) return "变基";
  if (st.cherryPicking) return "拣选";
  if (st.reverting) return "回退";
  if (st.bisecting) return "二分查找";
  return "";
}

/**
 * Turn git's stderr into a code the UI can act on.
 *
 * Ordering is deliberate: the specific cases come before the loose ones, so a
 * conflict that also mentions local changes still reads as a conflict.
 */
export function classify_git_failure(stderr: string): string {
  const s = String(stderr || "");
  if (/MERGE_HEAD exists|not concluded your merge|unmerged files/i.test(s)) return "operation-in-progress";
  if (/You have begun performing a pull|rebase in progress|apply by patch/i.test(s)) return "operation-in-progress";
  if (/already used by worktree|already checked out/i.test(s)) return "branch-in-other-worktree";
  if (/Automatic merge failed|CONFLICT \(/i.test(s)) return "conflict";
  if (/would be overwritten by (merge|checkout)/i.test(s)) return "would-overwrite";
  if (/Please commit your changes|stash your local changes|working tree (is )?dirty/i.test(s)) return "local-changes";
  if (/not something we can merge|unknown revision|bad revision|doesn't (exist|any commits)/i.test(s)) return "bad-revision";
  if (/Committer identity unknown|please tell me who you are|empty ident name/i.test(s)) return "identity-unknown";
  if (/no changes added to commit|nothing to commit/i.test(s)) return "nothing-to-commit";
  return "git-failed";
}

/** Paths git left in a conflicted state — read them before an abort wipes the index. */
export async function conflicted_paths(repo: string): Promise<string[]> {
  const r = git(repo, ["diff", "--name-only", "--diff-filter=U"]);
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map((p) => p.trim()).filter((p) => p !== "");
}

/** A name that is safe to paste into a refspec or a `branch -D` argument. */
export function ref_name_ok(name: string): boolean {
  const s = String(name || "");
  if (!s || s.startsWith("-")) return false;
  if (/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(s)) return false;
  if (s.includes("..") || s.includes("@{") || s.endsWith("/") || s.endsWith(".") || s.endsWith(".lock")) return false;
  return true;
}

/** A revision argument that cannot be read as an option. */
export function revision_arg_ok(name: string): boolean {
  const s = String(name || "");
  if (!s || s.startsWith("-")) return false;
  if (/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(s)) return false;
  if (s.includes("..") || s.includes("@{")) return false;
  return true;
}

export type CreateResult =
  | { ok: true; meta: WorktreeMeta }
  | { ok: false; error: string; code: string };

/**
 * Fork `repo_dir` into a fresh worktree on a fresh branch.
 *
 * The copy starts from COMMITTED state. Uncommitted edits in the main tree stay
 * there on purpose: half-finished work is not a base anyone can merge back
 * onto, and copying it would make every later merge conflict for no reason.
 */
export async function create(
  repo_dir: string,
  opts: { name?: string; base?: string } = {},
): Promise<CreateResult> {
  const top = await repo_toplevel(repo_dir);
  if (!top) {
    return { ok: false, error: "当前工作区不是 Git 仓库，无法创建副本", code: "not-a-repo" };
  }
  if (await is_linked_worktree(top)) {
    return { ok: false, error: "这个对话已经在副本里了，不能再嵌套一个", code: "already-isolated" };
  }

  let base = String(opts.base || "").trim();
  if (!base) {
    base = await current_branch(top);
    if (!base || base === "HEAD") {
      const short = git(top, ["rev-parse", "--short", "HEAD"]);
      base = short.code === 0 ? short.stdout.trim() : "HEAD";
    }
  }
  if (!revision_arg_ok(base)) {
    return { ok: false, error: `起点名称不可用：${base}`, code: "bad-revision" };
  }
  const verify = git(top, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (verify.code !== 0) {
    return { ok: false, error: `找不到起点分支：${base}`, code: "bad-revision" };
  }

  const root = worktrees_root(top);
  const slug = slugify(opts.name || "");
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (exc) {
    const why = (exc as { message?: string })?.message ?? String(exc);
    return { ok: false, error: `无法创建副本目录 ${root}：${why}`, code: "mkdir-failed" };
  }

  let lastError = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const suffix = attempt === 0 ? "" : `-${crypto.randomUUID().slice(0, 8)}`;
    const branch = `${BRANCH_PREFIX}${slug}${suffix}`;
    const wt_path = path.join(root, path.basename(branch));
    if (fs.existsSync(wt_path) || (await branch_exists(top, branch))) continue;

    const add = git(top, ["worktree", "add", "-b", branch, wt_path, base], 180);
    if (add.code === 0) {
      return { ok: true, meta: { repo: top, path: path.resolve(wt_path), branch, base } };
    }
    lastError = `${add.stderr}\n${add.stdout}`.trim();
    if (fs.existsSync(wt_path)) {
      try {
        fs.rmSync(wt_path, { recursive: true, force: true });
      } catch {
        // The retry will fail on the same path and report the real error.
      }
    }
    // A name collision is the only retryable failure; anything else is real.
    if (!/already exists/i.test(lastError)) break;
  }
  const code = classify_git_failure(lastError);
  return {
    ok: false,
    error: lastError.slice(0, 600) || "git worktree add 失败",
    code: code === "git-failed" ? "worktree-add-failed" : code,
  };
}

/** Read a session row's copy binding, or null when it has none. */
export function meta_from_row(row: Record<string, unknown> | null | undefined): WorktreeMeta | null {
  if (!row) return null;
  const p = String(row["worktree_path"] ?? "").trim();
  if (!p) return null;
  return {
    repo: String(row["worktree_repo"] ?? "").trim(),
    path: p,
    branch: String(row["worktree_branch"] ?? "").trim(),
    base: String(row["worktree_base"] ?? "").trim(),
  };
}

export interface WorktreeStatus {
  /** Always true — the payload only exists for a conversation that owns a copy. */
  isWorktree: boolean;
  exists: boolean;
  repo: string;
  path: string;
  branch: string;
  base: string;
  baseIsBranch: boolean;
  currentBranch: string;
  dirty: boolean;
  dirtyCount: number;
  ahead: number;
  behind: number;
  merged: boolean;
  repoBranch: string;
  repoDirty: boolean;
  /** The main project is inside a half-finished merge/rebase/… right now. */
  inProgress: boolean;
  /** 合并 / 变基 / 拣选 / 回退 / 二分查找, or "" when nothing is in progress. */
  operation: string;
}

export async function status(meta: WorktreeMeta): Promise<WorktreeStatus> {
  const exists = is_dir(meta.path);
  const out: WorktreeStatus = {
    isWorktree: true,
    exists,
    repo: meta.repo || "",
    path: meta.path || "",
    branch: meta.branch || "",
    base: meta.base || "",
    baseIsBranch: false,
    currentBranch: "",
    dirty: false,
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
    merged: true,
    repoBranch: "",
    repoDirty: false,
    inProgress: false,
    operation: "",
  };
  if (!meta.repo || !is_dir(meta.repo)) {
    out.merged = false;
    return out;
  }
  out.repoBranch = await current_branch(meta.repo);
  const busy = await repo_operation_state(meta.repo);
  out.inProgress = busy.merging || busy.rebasing || busy.cherryPicking || busy.reverting || busy.bisecting;
  out.operation = operation_state_label(busy);
  const repoStatus = git(meta.repo, ["status", "--porcelain"]);
  out.repoDirty = repoStatus.code === 0 && Boolean(repoStatus.stdout.trim());
  if (meta.base) out.baseIsBranch = await branch_exists(meta.repo, meta.base);
  if (!exists) {
    out.merged = false;
    return out;
  }

  out.currentBranch = await current_branch(meta.path);
  const st = git(meta.path, ["status", "--porcelain"]);
  if (st.code === 0) {
    out.dirtyCount = st.stdout.split(/\r?\n/).filter((l) => l.trim()).length;
    out.dirty = out.dirtyCount > 0;
  }
  if (meta.branch && meta.base) {
    const ahead = git(meta.repo, ["rev-list", "--count", `${meta.base}..${meta.branch}`]);
    if (ahead.code === 0) out.ahead = Number(ahead.stdout.trim() || "0") || 0;
    const behind = git(meta.repo, ["rev-list", "--count", `${meta.branch}..${meta.base}`]);
    if (behind.code === 0) out.behind = Number(behind.stdout.trim() || "0") || 0;
    out.merged = out.ahead === 0;
  }
  return out;
}

export type MergeResult =
  | { ok: true; branch: string; target: string; message: string }
  | { ok: false; error: string; conflict: boolean; code: string; conflictFiles: string[] };

function refuse(error: string, code: string, conflict = false, conflictFiles: string[] = []): MergeResult {
  return { ok: false, error, conflict, code, conflictFiles };
}

/**
 * Merge the copy's branch back into its base branch.
 *
 * Runs in the MAIN working tree, which is why it insists that tree is already
 * on the target branch and clean. Silently checking the user's branch out from
 * under them would move whatever they had in progress; `merge --abort` on
 * failure leaves the repo exactly as found.
 *
 * "Exactly as found" is also why it refuses a repository that is already inside
 * someone else's half-finished merge: aborting there would throw away conflict
 * resolution the user did by hand.
 */
export async function merge_back(meta: WorktreeMeta, target?: string): Promise<MergeResult> {
  if (!meta.repo || !meta.branch) {
    return refuse("这个对话没有可合并的副本分支", "no-branch");
  }
  if (!is_dir(meta.repo)) {
    return refuse("找不到原始仓库目录", "repo-missing");
  }
  const busy = await repo_operation_state(meta.repo);
  if (operation_state_label(busy) !== "") {
    return refuse(
      `主项目里还有一次没做完的${operation_state_label(busy)}，先把它处理完（提交或放弃）再合并`,
      "operation-in-progress",
    );
  }
  if (!(await branch_exists(meta.repo, meta.branch))) {
    return refuse(`分支 ${meta.branch} 已不存在`, "branch-missing");
  }
  const tgt = String(target || meta.base || "").trim();
  if (!tgt) return refuse("没有指定的目标分支", "no-target");
  if (!ref_name_ok(meta.branch) || !ref_name_ok(tgt)) {
    return refuse("分支名称不可用，已拒绝合并", "bad-name");
  }
  if (!(await branch_exists(meta.repo, tgt))) {
    return refuse(`目标 ${tgt} 不是本地分支，请选择要合并进的分支`, "target-missing");
  }
  const repoBranch = await current_branch(meta.repo);
  if (repoBranch !== tgt) {
    return refuse(
      `主工作区当前在 ${repoBranch || "游离 HEAD"}，请先切回 ${tgt} 再合并`,
      "wrong-branch",
    );
  }
  const st = git(meta.repo, ["status", "--porcelain"]);
  if (st.code === 0 && st.stdout.trim()) {
    return refuse("主工作区有未提交改动，请先提交或撤销后再合并", "local-changes");
  }

  const merge = git(
    meta.repo,
    ["merge", "--no-ff", meta.branch, "-m", `merge: ${meta.branch} into ${tgt}`],
    180,
  );
  if (merge.code === 0) {
    return { ok: true, branch: meta.branch, target: tgt, message: merge.stdout.trim().slice(0, 2000) };
  }
  const files = await conflicted_paths(meta.repo);
  git(meta.repo, ["merge", "--abort"]);
  const msg = `${merge.stderr}\n${merge.stdout}`.trim();
  const code = classify_git_failure(msg);
  const error =
    code === "conflict" && files.length > 0
      ? `与 ${tgt} 有 ${files.length} 个文件冲突：${files.slice(0, 6).join("、")}${files.length > 6 ? "…" : ""}`
      : (code === "git-failed" ? msg.slice(0, 600) : msg.slice(0, 200)) || `合并 ${meta.branch} 失败`;
  return refuse(error.slice(0, 600) || `合并 ${meta.branch} 失败`, code, code === "conflict", files);
}

export interface DisposeResult {
  ok: boolean;
  /** The branch still exists after disposal (unmerged work was preserved). */
  keptBranch: boolean;
  /** The directory was left on disk because it could not be cleaned safely. */
  preserved: boolean;
  error?: string;
}

/**
 * Remove a conversation's copy, keeping any work it holds.
 *
 * Order matters: snapshot first, then delete the directory, then decide about
 * the branch. A dirty tree would otherwise be destroyed by
 * `worktree remove --force`, and an unmerged branch would take its commits with
 * it — so an unmerged branch always survives with its name reported back.
 */
export async function dispose(
  meta: WorktreeMeta,
  opts: { deleteBranch?: boolean } = {},
): Promise<DisposeResult> {
  const res: DisposeResult = { ok: true, keptBranch: false, preserved: false };
  if (!meta.repo || !is_dir(meta.repo)) {
    return { ...res, ok: false, error: "找不到原始仓库目录", preserved: true };
  }
  if (meta.path && !inside(worktrees_root(meta.repo), meta.path)) {
    // A corrupted row must never turn into a recursive delete on an arbitrary folder.
    return { ...res, ok: false, error: "副本路径不在受管目录内，已拒绝删除", preserved: true };
  }

  if (is_dir(meta.path)) {
    const st = git(meta.path, ["status", "--porcelain"]);
    if (st.code === 0 && st.stdout.trim()) {
      git(meta.path, ["add", "-A"]);
      // Journal-only commit: its whole job is to stop `worktree remove --force`
      // from destroying work. User hooks would only make deletion hang.
      const commit = git(
        meta.path,
        ["commit", "-m", "chore: snapshot before removing worktree", "--no-verify"],
        180,
      );
      if (commit.code !== 0) {
        const why = `${commit.stderr}\n${commit.stdout}`.trim().slice(0, 300);
        return {
          ...res,
          ok: false,
          preserved: true,
          keptBranch: await branch_exists(meta.repo, meta.branch),
          error: `副本里有未提交改动且无法自动保存，已保留现场${why ? `（${why}）` : ""}`,
        };
      }
    }
    const rm = git(meta.repo, ["worktree", "remove", "--force", meta.path], 180);
    if (rm.code !== 0 && is_dir(meta.path)) {
      try {
        fs.rmSync(meta.path, { recursive: true, force: true });
      } catch {
        // Fall through: the branch decision below still reports what survived.
      }
    }
    git(meta.repo, ["worktree", "prune"]);
  }

  const branchAlive = await branch_exists(meta.repo, meta.branch);
  let merged = false;
  if (branchAlive && meta.base) {
    const cnt = git(meta.repo, ["rev-list", "--count", `${meta.base}..${meta.branch}`]);
    if (cnt.code === 0) merged = Number(cnt.stdout.trim() || "0") === 0;
  }
  const shouldDelete =
    opts.deleteBranch === true ? true : opts.deleteBranch === false ? false : merged;
  if (branchAlive && shouldDelete) {
    const del = git(meta.repo, ["branch", "-D", meta.branch]);
    res.keptBranch = del.code !== 0;
  } else {
    res.keptBranch = branchAlive;
  }
  return res;
}
