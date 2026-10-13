/**
 * http_server_s8.ts — 单元 218 `app/backend/server/http_server.py`（8819 源行）的 **段 S8**。
 * 分段方案 `tmp/w218_SEGMENTS.md` · 契约表 `tmp/w218_SURFACE.md`（本段 = 其 §S8 的 11 行）·
 * 镜像层单一来源 keys.ts §M（上收符号以 `node tmp/lead_mirror_single_source_check.mjs s8` 现查为准，
 *   本文件**全部 import，零私有副本**）。
 *
 * 覆盖源区间 **6668–7490**（git + shadow handler 簇）：
 *   6668–6707  _git_router / _router_for_request   （模块级 helper）
 *   6709–6723  _git_proc                          （模块级 helper）
 *   6725–6768  _git_out_sync                      （模块级 helper）
 *   6770–6779  _git_out                           （模块级 helper）
 *   6781–6784  _git_proc_async                    （模块级 helper）
 *   6786–6794  _git_branch_label                  （模块级 helper）
 *   6796–6807  _unquote_porcelain_path            （模块级 helper）
 *   6809–6841  _parse_porcelain                   （模块级 helper）
 *   6849–6886  _untracked_additions_sync          （模块级 helper）
 *   6888–6897  _clean_numstat_path                （模块级 helper）
 *   6899–6933  _untracked_additions_detailed_sync （模块级 helper）
 *   6935–6972  _git_diffstat_detailed             （模块级 helper）
 *   6974–6978  _git_diffstat                      （模块级 helper）
 *   6980–6994  handle_shadow_status               GET    /api/shadow/{sessionId}/status   #133
 *   6996–7014  handle_shadow_validate             POST   /api/shadow/{sessionId}/validate #134
 *   7016–7042  handle_shadow_apply                POST   /api/shadow/{sessionId}/apply    #135
 *   7044–7055  handle_shadow_discard              POST   /api/shadow/{sessionId}/discard  #136
 *   7057–7119  _resolve_git_repo                  （模块级 helper）
 *   7121–7188  handle_git_status                  GET    /api/git/status                  #123
 *   7190–7275  handle_git_diff                    GET    /api/git/diff                    #124
 *   7277–7294  handle_git_branches                GET    /api/git/branches                #125
 *   7296–7336  handle_git_restore                 POST   /api/git/restore                 #127
 *   7338–7372  handle_git_checkout                POST   /api/git/checkout                #128
 *   7374–7419  handle_git_create_branch           POST   /api/git/branch                  #129
 *   7421–7489  handle_git_log                     GET    /api/git/log                     #126
 *
 * **计数**：11 条注册 / 11 个 handler（`handle_*`），另 13 个模块级 helper。
 */

import {
  json_response,
  text_response,
  py_int,
  py_float,
  py_or,
  py_str,
  py_truth,
  py_type_name,
  py_is_none,
  py_repr,
  py_dict_get,
  py_getattr,
  py_getattr_or,
  py_iter,
  py_strip,
  os_path_join,
  exc_str,
  PyExcP,
  PyKeyError,
  ROUTER_KEY,
  SESSION_HOST_KEY,
  SERVER_STATE,
  type JsonDict,
  type WebRequest,
  type WebResponse,
} from "./http_server_keys.js";

type RequestLike = WebRequest;
type ResponseLike = WebResponse;

class PyValueErrorP extends PyExcP {
  constructor(message: string) {
    super("ValueError", message);
  }
}

function app_state_get(app: unknown, key: unknown): unknown {
  if (app && typeof app === "object") {
    if (typeof (app as any).get === "function") {
      return (app as any).get(key);
    }
    return (app as any)[key as any];
  }
  return undefined;
}

function app_state_require(app: unknown, key: unknown): unknown {
  const v = app_state_get(app, key);
  if (v === undefined) {
    throw new PyKeyError(`App key ${String(key)} not found`);
  }
  return v;
}

// ── S8 Seams ────────────────────────────────────────────────────────────────
export const HTTP_S8_SEAM_KEYS = [
  "session_host_module",
  "shadow_session_module",
  "shadow_workspace_module",
  "subprocess_git_runner",
  "fs_reader",
] as const;

export type HttpS8SeamKey = (typeof HTTP_S8_SEAM_KEYS)[number];

const _s8_seams: Record<string, () => any> = {};

export function register_s8_seam<K extends HttpS8SeamKey>(key: K, getter: () => any): void {
  _s8_seams[key] = getter;
}

export function reset_s8_seams_for_probe(): void {
  for (const k of HTTP_S8_SEAM_KEYS) {
    delete _s8_seams[k];
  }
}

function get_seam<K extends HttpS8SeamKey>(key: K): any {
  const fn = _s8_seams[key];
  if (fn) return fn();
  return null;
}

// ── Constants (6845–6846) ───────────────────────────────────────────────────
export const _UNTRACKED_FILES_CAP = 50;
export const _UNTRACKED_BYTES_CAP = 512 * 1024;

// ── Module Helper: _git_router (6668–6707) ──────────────────────────────────
export async function _git_router(request: RequestLike): Promise<any> {
  let sid = "";
  if (request.query) {
    sid = request.query.get("session_id") || request.query.get("sessionId") || "";
  }
  const method = request.method ? request.method.toUpperCase() : "GET";
  if (!sid && (method === "POST" || method === "PUT" || method === "PATCH")) {
    try {
      const body: any = await request.json();
      sid = py_str(py_dict_get(body, "session_id", py_dict_get(body, "sessionId", "")));
    } catch {
      sid = "";
    }
  }
  if (sid) {
    try {
      const sh = get_seam("session_host_module");
      if (sh && typeof sh.get_session_host === "function") {
        const host = sh.get_session_host();
        if (host && typeof host.get === "function") {
          const router = host.get(sid);
          if (router !== null && router !== undefined) {
            return router;
          }
        }
      }
    } catch {
      // fail-open
    }
  }
  return app_state_require(request.app, ROUTER_KEY);
}

export const _router_for_request = _git_router;

// ── Module Helper: _git_proc (6709–6723) ────────────────────────────────────
export function _git_proc(repo: string, args: string[], timeout = 60): any {
  const runner = get_seam("subprocess_git_runner");
  if (runner && typeof runner.run === "function") {
    return runner.run(repo, args, timeout);
  }
  return {
    returncode: 1,
    stdout: "",
    stderr: "git not available",
  };
}

// ── Module Helper: _git_out_sync (6725–6768) ────────────────────────────────
export function _git_out_sync(repo: string, args: string[]): string {
  try {
    const proc = _git_proc(repo, args, 15);
    if (!proc || proc.returncode !== 0) {
      return "";
    }
    const stdout = proc.stdout || "";
    return stdout.replace(/[\r\n]+$/, "");
  } catch {
    return "";
  }
}

// ── Module Helper: _git_out (6770–6779) ─────────────────────────────────────
export async function _git_out(repo: string, args: string[]): Promise<string> {
  const runner = get_seam("subprocess_git_runner");
  if (runner && typeof runner.run_async === "function") {
    const res = await runner.run_async(repo, args, 15);
    if (!res || res.returncode !== 0) return "";
    return (res.stdout || "").replace(/[\r\n]+$/, "");
  }
  return _git_out_sync(repo, args);
}

// ── Module Helper: _git_proc_async (6781–6784) ──────────────────────────────
export async function _git_proc_async(repo: string, args: string[], timeout = 60): Promise<any> {
  const runner = get_seam("subprocess_git_runner");
  if (runner && typeof runner.run_async === "function") {
    return await runner.run_async(repo, args, timeout);
  }
  return _git_proc(repo, args, timeout);
}

// ── Module Helper: _git_branch_label (6786–6794) ────────────────────────────
export async function _git_branch_label(repo: string): Promise<string> {
  const branch = await _git_out(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") {
    const short = await _git_out(repo, ["rev-parse", "--short", "HEAD"]);
    return short ? `(${short})` : "HEAD";
  }
  return branch;
}

// ── Module Helper: _unquote_porcelain_path (6796–6807) ──────────────────────
export function _unquote_porcelain_path(p: string): string {
  const trimmed = p.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

// ── Module Helper: _parse_porcelain (6809–6841) ─────────────────────────────
export function _parse_porcelain(lines: string[]): Array<{ path: string; kind: string; staged: boolean }> {
  const kinds: Record<string, string> = {
    M: "modified",
    A: "added",
    D: "deleted",
    R: "renamed",
    C: "copied",
    "?": "untracked",
    U: "conflicted",
  };
  const changes: Array<{ path: string; kind: string; staged: boolean }> = [];
  for (const line of lines) {
    if (line.length < 4) continue;
    const index = line[0]!;
    const worktree = line[1]!;
    let rest = line.slice(3);
    if (rest.includes(" -> ")) {
      const idx = rest.lastIndexOf(" -> ");
      rest = rest.slice(idx + 4);
    }
    const path = _unquote_porcelain_path(rest);
    let code = index !== " " && index !== "?" ? index : worktree;
    if (index === "?" && worktree === "?") {
      code = "?";
    }
    changes.push({
      path,
      kind: kinds[code] || "modified",
      staged: index !== " " && index !== "?",
    });
  }
  return changes;
}

// ── Module Helper: _clean_numstat_path (6888–6897) ──────────────────────────
export function _clean_numstat_path(p: string): string {
  let s = p.trim();
  if (s.includes(" => ")) {
    s = s.replace(/\{.*?=>\s*(.*?)\}/g, "$1");
    if (s.includes(" => ")) {
      const parts = s.split(" => ");
      s = parts[parts.length - 1]!;
    }
    s = s.replace(/\/\//g, "/");
  }
  return s.trim();
}

// ── Module Helper: _untracked_additions_sync (6849–6886) ─────────────────────
export function _untracked_additions_sync(repo: string, paths: string[]): number {
  const fsReader = get_seam("fs_reader");
  if (fsReader && typeof fsReader.untracked_additions === "function") {
    return fsReader.untracked_additions(repo, paths, _UNTRACKED_FILES_CAP, _UNTRACKED_BYTES_CAP);
  }
  return 0;
}

// ── Module Helper: _untracked_additions_detailed_sync (6899–6933) ───────────
export function _untracked_additions_detailed_sync(repo: string, paths: string[]): Record<string, number> {
  const fsReader = get_seam("fs_reader");
  if (fsReader && typeof fsReader.untracked_additions_detailed === "function") {
    return fsReader.untracked_additions_detailed(repo, paths, _UNTRACKED_FILES_CAP, _UNTRACKED_BYTES_CAP);
  }
  const res: Record<string, number> = {};
  for (const p of paths) {
    res[p] = 0;
  }
  return res;
}

// ── Module Helper: _git_diffstat_detailed (6935–6972) ───────────────────────
export async function _git_diffstat_detailed(
  repo: string,
  untracked_paths: string[]
): Promise<[number, number, Record<string, [number, number]>]> {
  const per_file: Record<string, [number, number]> = {};
  let numstat = await _git_out(repo, ["diff", "--numstat", "HEAD"]);
  if (!numstat) {
    numstat = await _git_out(repo, ["diff", "--numstat"]);
    const staged = await _git_out(repo, ["diff", "--cached", "--numstat"]);
    if (staged) {
      numstat = (numstat + "\n" + staged).trim();
    }
  }

  for (const rawLine of numstat.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const a = parts[0] === "-" ? 0 : parseInt(parts[0] || "0", 10) || 0;
    const d = parts[1] === "-" ? 0 : parseInt(parts[1] || "0", 10) || 0;
    if (parts.length >= 3) {
      const raw_path = parts[2]!.trim();
      const clean_path = _clean_numstat_path(raw_path).replace(/\\/g, "/");
      const cur = per_file[clean_path] || [0, 0];
      per_file[clean_path] = [cur[0] + a, cur[1] + d];
    }
  }

  const untracked_map = _untracked_additions_detailed_sync(repo, untracked_paths);
  for (const [p, count] of Object.entries(untracked_map)) {
    const norm_p = p.replace(/\\/g, "/");
    const cur = per_file[norm_p] || [0, 0];
    per_file[norm_p] = [cur[0] + count, cur[1]];
  }

  let total_additions = 0;
  let total_deletions = 0;
  for (const [a, d] of Object.values(per_file)) {
    total_additions += a;
    total_deletions += d;
  }
  return [total_additions, total_deletions, per_file];
}

// ── Module Helper: _git_diffstat (6974–6978) ────────────────────────────────
export async function _git_diffstat(repo: string, untracked_paths: string[]): Promise<[number, number]> {
  const [total_a, total_d] = await _git_diffstat_detailed(repo, untracked_paths);
  return [total_a, total_d];
}

// ── Handler 133: handle_shadow_status (6980–6994) ───────────────────────────
export async function handle_shadow_status(request: RequestLike): Promise<ResponseLike> {
  const sessionId = request.match_info ? request.match_info.get("sessionId", "") : "";
  let workspace = "";
  if (request.query) {
    workspace = py_strip(request.query.get("workspace") || "");
  }
  if (!sessionId) {
    return json_response({ error: "sessionId required" }, 400);
  }
  try {
    const ss = get_seam("shadow_session_module");
    if (!ss || typeof ss.status !== "function") {
      return json_response({ error: "shadow_session not found" }, 500);
    }
    if (!workspace) {
      const router: any = app_state_get(request.app, ROUTER_KEY);
      workspace = router ? py_str(py_getattr_or(router, "workspace", "")) : "";
    }
    return json_response(ss.status(sessionId, workspace));
  } catch (exc: any) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

// ── Handler 134: handle_shadow_validate (6996–7014) ─────────────────────────
export async function handle_shadow_validate(request: RequestLike): Promise<ResponseLike> {
  const sessionId = request.match_info ? request.match_info.get("sessionId", "") : "";
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  let workspace = "";
  if (body && typeof body === "object") {
    workspace = py_str(py_dict_get(body, "workspace", ""));
  }
  if (!workspace && request.query) {
    workspace = request.query.get("workspace") || "";
  }
  workspace = py_strip(workspace);
  if (!sessionId) {
    return json_response({ error: "sessionId required" }, 400);
  }
  try {
    const ss = get_seam("shadow_session_module");
    const sw = get_seam("shadow_workspace_module");
    if (!ss || !sw) {
      return json_response({ error: "shadow modules not found" }, 500);
    }
    if (!workspace) {
      const router: any = app_state_get(request.app, ROUTER_KEY);
      workspace = router ? py_str(py_getattr_or(router, "workspace", "")) : "";
    }
    const wc = (ss.get_session && ss.get_session(sessionId)) || (ss.ensure_session && ss.ensure_session(sessionId, workspace));
    const report = sw.validate_workcopy(wc, workspace);
    return json_response(report && typeof report.to_dict === "function" ? report.to_dict() : report);
  } catch (exc: any) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

// ── Handler 135: handle_shadow_apply (7016–7042) ────────────────────────────
export async function handle_shadow_apply(request: RequestLike): Promise<ResponseLike> {
  const sessionId = request.match_info ? request.match_info.get("sessionId", "") : "";
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  let workspace = "";
  if (body && typeof body === "object") {
    workspace = py_str(py_dict_get(body, "workspace", ""));
  }
  workspace = py_strip(workspace);
  if (!sessionId) {
    return json_response({ error: "sessionId required" }, 400);
  }
  try {
    const ss = get_seam("shadow_session_module");
    const sw = get_seam("shadow_workspace_module");
    if (!ss || !sw) {
      return json_response({ error: "shadow modules not found" }, 500);
    }
    if (!workspace) {
      const router: any = app_state_get(request.app, ROUTER_KEY);
      workspace = router ? py_str(py_getattr_or(router, "workspace", "")) : "";
    }
    const wc = ss.get_session ? ss.get_session(sessionId) : null;
    if (wc === null || wc === undefined) {
      return json_response({ error: "no staged overlay" }, 404);
    }
    const report = sw.validate_workcopy(wc, workspace);
    if (!report || !report.ok) {
      return json_response(
        {
          error: "validation failed",
          report: report && typeof report.to_dict === "function" ? report.to_dict() : report,
        },
        409
      );
    }
    const result = ss.apply_session(sessionId);
    return json_response({ ok: true, merge: result });
  } catch (exc: any) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

// ── Handler 136: handle_shadow_discard (7044–7055) ──────────────────────────
export async function handle_shadow_discard(request: RequestLike): Promise<ResponseLike> {
  const sessionId = request.match_info ? request.match_info.get("sessionId", "") : "";
  if (!sessionId) {
    return json_response({ error: "sessionId required" }, 400);
  }
  try {
    const ss = get_seam("shadow_session_module");
    if (ss && typeof ss.discard_session === "function") {
      ss.discard_session(sessionId);
    }
    return json_response({ ok: true });
  } catch (exc: any) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

// ── Module Helper: _resolve_git_repo (7057–7119) ────────────────────────────
export async function _resolve_git_repo(
  request: RequestLike
): Promise<[string | null, any, Record<string, unknown> | null]> {
  const router: any = await _git_router(request);
  let sid = "";
  if (request.query) {
    sid = request.query.get("session_id") || request.query.get("sessionId") || "";
  }
  if (!sid && router) {
    sid = py_str(py_getattr_or(router, "session_id", ""));
  }
  const method = request.method ? request.method.toUpperCase() : "GET";
  if (!sid && (method === "POST" || method === "PUT" || method === "PATCH")) {
    try {
      const body: any = await request.json();
      sid = py_str(py_dict_get(body, "session_id", py_dict_get(body, "sessionId", "")));
    } catch {
      sid = "";
    }
  }

  if (sid && router && router.storage) {
    try {
      const sess = router.storage.get_session(sid);
      if (sess !== null && sess !== undefined) {
        const ws = py_strip(py_str(py_dict_get(sess, "workspace", "")));
        if (!ws) {
          return [null, router, { isGitRepository: false, workspaceOpen: false }];
        }
      }
    } catch {
      // pass
    }
  }

  if (!router || !py_getattr_or(router, "workspace_selected", false)) {
    return [null, router, { isGitRepository: false, workspaceOpen: false }];
  }

  const effective_ws = py_str(py_getattr_or(router, "effective_workspace", ""));
  if (!effective_ws) {
    return [null, router, { isGitRepository: false, workspaceOpen: false }];
  }

  const repo = py_str(py_getattr_or(router, "workspace", ""));
  if (!repo) {
    return [null, router, { isGitRepository: false, workspaceOpen: false }];
  }

  const isInside = (await _git_out(repo, ["rev-parse", "--is-inside-work-tree"])) === "true";
  if (!isInside) {
    return [null, router, { isGitRepository: false, workspaceOpen: true }];
  }

  const toplevel = await _git_out(repo, ["rev-parse", "--show-toplevel"]);
  const runner = get_seam("subprocess_git_runner");
  let has_git = false;
  if (runner && typeof runner.has_git_dir === "function") {
    has_git = runner.has_git_dir(repo);
  }
  let is_root = false;
  if (toplevel) {
    is_root = toplevel.toLowerCase().replace(/\\/g, "/") === repo.toLowerCase().replace(/\\/g, "/");
  }

  if (!has_git && !is_root) {
    return [null, router, { isGitRepository: false, workspaceOpen: true }];
  }

  return [repo ? repo : null, router, null];
}

// ── Handler 123: handle_git_status (7121–7188) ──────────────────────────────
export async function handle_git_status(request: RequestLike): Promise<ResponseLike> {
  const [repo, router, err] = await _resolve_git_repo(request);
  if (err !== null) {
    return json_response(err);
  }
  if (!repo) {
    return json_response({ isGitRepository: false, workspaceOpen: false });
  }

  const porcelain = await _git_out(repo, ["status", "--porcelain", "-u", "-z"]);
  const lines: string[] = [];
  const untracked: string[] = [];
  const entries = porcelain.split("\0");
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    i += 1;
    if (entry.length < 4) continue;
    lines.push(entry);
    if (entry[0] === "?" && entry[1] === "?") {
      untracked.push(_unquote_porcelain_path(entry.slice(3)));
    }
    if ((entry[0] === "R" || entry[0] === "C") && i < entries.length) {
      i += 1;
    }
  }

  const upstream = await _git_out(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  const has_upstream = Boolean(upstream);
  let ahead = 0;
  let behind = 0;
  if (has_upstream) {
    const ahead_behind = await _git_out(repo, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    try {
      const parts = ahead_behind.trim().split(/\s+/);
      behind = parseInt(parts[0] || "0", 10) || 0;
      ahead = parseInt(parts[1] || "0", 10) || 0;
    } catch {
      ahead = behind = 0;
    }
  }

  const [additions, deletions, per_file] = await _git_diffstat_detailed(repo, untracked);
  const changes = _parse_porcelain(lines) as Array<Record<string, unknown>>;
  for (const c of changes) {
    const p = String(c["path"] || "").replace(/\\/g, "/");
    let pair = per_file[p];
    if (!pair) {
      if (p.endsWith("/")) {
        pair = per_file[p.slice(0, -1)];
      } else {
        pair = per_file[p + "/"];
      }
    }
    c["additions"] = pair ? pair[0] : 0;
    c["deletions"] = pair ? pair[1] : 0;
  }

  const branchLabel = await _git_branch_label(repo);
  const userName = await _git_out(repo, ["config", "user.name"]);
  const recentLog = await _git_out(repo, ["log", "--oneline", "-n", "10"]);
  const recentCommits = recentLog
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return json_response({
    isGitRepository: true,
    workspaceOpen: true,
    branch: branchLabel,
    user: userName,
    ahead,
    behind,
    hasUpstream: has_upstream,
    status: lines.length > 0 ? "dirty" : "clean",
    changes,
    additions,
    deletions,
    recentCommits,
  });
}

// ── Handler 124: handle_git_diff (7190–7275) ────────────────────────────────
export async function handle_git_diff(request: RequestLike): Promise<ResponseLike> {
  const [repo, router, err] = await _resolve_git_repo(request);
  if (err !== null) {
    return json_response(err);
  }
  if (!repo) {
    return json_response({ error: "no repo" }, 400);
  }

  let rel_path = "";
  if (request.query) {
    rel_path = (request.query.get("path") || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  }
  let is_untracked = false;
  if (rel_path) {
    const porcelain = await _git_out(repo, ["status", "--porcelain", "-u", "-z", "--", rel_path]);
    if (porcelain.startsWith("??")) {
      is_untracked = true;
    }
  }

  let diff_text = "";
  let old_content = "";
  let new_content = "";
  let additions = 0;
  let deletions = 0;

  if (is_untracked) {
    const fsReader = get_seam("fs_reader");
    if (fsReader && typeof fsReader.read_file === "function") {
      try {
        new_content = fsReader.read_file(repo, rel_path) || "";
        const lines = new_content.split(/\r?\n/);
        additions = lines.length;
        diff_text = `--- /dev/null\n+++ b/${rel_path}\n@@ -0,0 +1,${Math.max(1, additions)} @@\n` + lines.map((l) => "+" + l).join("\n");
      } catch (e: any) {
        return json_response({ error: exc_str(e) }, 500);
      }
    }
  } else {
    if (rel_path) {
      old_content = await _git_out(repo, ["show", `HEAD:${rel_path}`]);
      const fsReader = get_seam("fs_reader");
      if (fsReader && typeof fsReader.read_file === "function") {
        try {
          new_content = fsReader.read_file(repo, rel_path) || "";
        } catch {
          new_content = "";
        }
      }
      diff_text = await _git_out(repo, ["diff", "HEAD", "--", rel_path]);
      if (!diff_text) {
        diff_text = await _git_out(repo, ["diff", "--", rel_path]);
        if (!diff_text) {
          diff_text = await _git_out(repo, ["diff", "--cached", "--", rel_path]);
        }
      }

      let numstat = await _git_out(repo, ["diff", "--numstat", "HEAD", "--", rel_path]);
      if (!numstat) {
        numstat = await _git_out(repo, ["diff", "--numstat", "--", rel_path]);
        if (!numstat) {
          numstat = await _git_out(repo, ["diff", "--cached", "--numstat", "--", rel_path]);
        }
      }
      for (const rawLine of numstat.split("\n")) {
        const parts = rawLine.trim().split("\t");
        if (parts.length >= 2) {
          additions = parts[0] === "-" ? 0 : parseInt(parts[0] || "0", 10) || 0;
          deletions = parts[1] === "-" ? 0 : parseInt(parts[1] || "0", 10) || 0;
          break;
        }
      }
    } else {
      diff_text = await _git_out(repo, ["diff", "HEAD"]);
      if (!diff_text) {
        diff_text = await _git_out(repo, ["diff"]);
      }
    }
  }

  return json_response({
    ok: true,
    path: rel_path,
    diff: diff_text,
    targetContent: old_content,
    replacementContent: new_content,
    additions,
    deletions,
    isUntracked: is_untracked,
  });
}

// ── Handler 125: handle_git_branches (7277–7294) ────────────────────────────
export async function handle_git_branches(request: RequestLike): Promise<ResponseLike> {
  const [repo, router, err] = await _resolve_git_repo(request);
  if (err !== null) {
    return json_response({
      isGitRepository: false,
      workspaceOpen: err["workspaceOpen"] || false,
      branches: [],
    });
  }
  if (!repo) {
    return json_response({ isGitRepository: false, workspaceOpen: false, branches: [] });
  }

  const current = await _git_branch_label(repo);
  const raw = await _git_out(repo, ["branch", "--format=%(refname:short)"]);
  const branches = raw
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  return json_response({
    isGitRepository: true,
    current,
    branches,
  });
}

// ── Handler 127: handle_git_restore (7296–7336) ─────────────────────────────
export async function handle_git_restore(request: RequestLike): Promise<ResponseLike> {
  const [repo, router, err] = await _resolve_git_repo(request);
  if (err !== null) {
    if (!err["workspaceOpen"]) {
      return json_response(
        { error: "No workspace is open — open a folder before using git actions" },
        409
      );
    }
    return json_response({ error: "Not a git repository" }, 400);
  }
  if (!repo) {
    return json_response({ error: "Not a git repository" }, 400);
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (!body.confirmed) {
    return json_response(
      { error: "Restore requires confirmed:true from the Undo UI" },
      400
    );
  }

  let paths = body.paths || [];
  if (!Array.isArray(paths)) {
    paths = [];
  }
  const args = ["restore", "--source=HEAD", "--worktree", "--staged"];
  if (paths.length > 0) {
    args.push("--", ...paths.map(String));
  } else {
    args.push("--", ".");
  }

  try {
    const proc = await _git_proc_async(repo, args, 30);
    if (!proc || proc.returncode !== 0) {
      const errMsg = (proc && (proc.stderr || proc.stdout)) || "git restore failed";
      return json_response({ error: errMsg.slice(0, 400) }, 400);
    }
  } catch (e: any) {
    return json_response({ error: exc_str(e) }, 500);
  }
  return json_response({ ok: true });
}

// ── Handler 128: handle_git_checkout (7338–7372) ────────────────────────────
export async function handle_git_checkout(request: RequestLike): Promise<ResponseLike> {
  const [repo, router, err] = await _resolve_git_repo(request);
  if (err !== null) {
    if (!err["workspaceOpen"]) {
      return json_response(
        { error: "No workspace is open — open a folder before using git actions" },
        409
      );
    }
    return json_response({ error: "Not a git repository" }, 400);
  }
  if (!repo) {
    return json_response({ error: "Not a git repository" }, 400);
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const branch = py_strip(py_str(py_dict_get(body, "branch", "")));
  if (!branch || !/^[\w./_-]+$/.test(branch)) {
    return json_response({ error: "Invalid branch name" }, 400);
  }

  const dirty = await _git_out(repo, ["status", "--porcelain"]);
  if (dirty) {
    return json_response(
      { error: "工作区有未提交改动，请先提交或撤销后再切换分支" },
      409
    );
  }

  try {
    const proc = await _git_proc_async(repo, ["checkout", branch], 30);
    if (!proc || proc.returncode !== 0) {
      const errMsg = (proc && (proc.stderr || proc.stdout)) || "checkout failed";
      return json_response({ error: errMsg.slice(0, 400) }, 400);
    }
  } catch (e: any) {
    return json_response({ error: exc_str(e) }, 500);
  }
  return json_response({ ok: true, branch });
}

// ── Handler 129: handle_git_create_branch (7374–7419) ───────────────────────
export async function handle_git_create_branch(request: RequestLike): Promise<ResponseLike> {
  const [repo, router, err] = await _resolve_git_repo(request);
  if (err !== null) {
    if (!err["workspaceOpen"]) {
      return json_response(
        { error: "No workspace is open — open a folder before using git actions" },
        409
      );
    }
    return json_response({ error: "Not a git repository" }, 400);
  }
  if (!repo) {
    return json_response({ error: "Not a git repository" }, 400);
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const name = py_strip(py_str(py_dict_get(body, "name", py_dict_get(body, "branch", ""))));
  const do_checkout = py_dict_get(body, "checkout", true);
  if (!name || !/^[\w./_-]+$/.test(name) || name.startsWith(".") || name.endsWith(".lock")) {
    return json_response({ error: "无效的分支名" }, 400);
  }

  if (py_truth(do_checkout)) {
    const dirty = await _git_out(repo, ["status", "--porcelain"]);
    if (dirty) {
      return json_response(
        { error: "工作区有未提交改动，请先提交或撤销后再创建并切换" },
        409
      );
    }
  }

  try {
    const create = await _git_proc_async(repo, ["branch", name], 30);
    if (!create || create.returncode !== 0) {
      const errMsg = (create && (create.stderr || create.stdout)) || "branch create failed";
      return json_response({ error: errMsg.slice(0, 400) }, 400);
    }
    if (py_truth(do_checkout)) {
      const co = await _git_proc_async(repo, ["checkout", name], 30);
      if (!co || co.returncode !== 0) {
        const errMsg = (co && (co.stderr || co.stdout)) || "checkout failed";
        return json_response({ error: errMsg.slice(0, 400) }, 400);
      }
    }
  } catch (e: any) {
    return json_response({ error: exc_str(e) }, 500);
  }
  return json_response({ ok: true, branch: name, checkedOut: Boolean(py_truth(do_checkout)) });
}

// ── Handler 126: handle_git_log (7421–7489) ─────────────────────────────────
export async function handle_git_log(request: RequestLike): Promise<ResponseLike> {
  const [repo, router, err] = await _resolve_git_repo(request);
  if (err !== null) {
    return json_response({
      isGitRepository: false,
      workspaceOpen: err["workspaceOpen"] || false,
      commits: [],
    });
  }
  if (!repo) {
    return json_response({ isGitRepository: false, workspaceOpen: false, commits: [] });
  }

  let limit = 40;
  if (request.query) {
    try {
      limit = parseInt(request.query.get("limit") || "40", 10) || 40;
    } catch {
      limit = 40;
    }
  }
  limit = Math.max(1, Math.min(limit, 200));

  const fmt = "%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1e";
  const raw = await _git_out(repo, [
    "log",
    `--max-count=${limit}`,
    `--pretty=format:${fmt}`,
    "--decorate=short",
  ]);

  const commits: Array<Record<string, unknown>> = [];
  for (const entryRaw of raw.split("\x1e")) {
    const entry = entryRaw.replace(/[\r\n]+$/, "");
    if (!entry.trim()) continue;
    const parts = entry.split("\x1f");
    if (parts.length < 5) continue;
    const full = parts[0]!;
    const short = parts[1]!;
    const subject = parts[2]!;
    const author = parts[3]!;
    const iso = parts[4]!;
    const deco = parts.length > 5 ? parts[5]! : "";

    const refs: string[] = [];
    let is_head = false;
    for (const pieceRaw of deco.split(",")) {
      const piece = pieceRaw.trim();
      if (!piece) continue;
      if (piece.startsWith("HEAD -> ")) {
        is_head = true;
        refs.push("HEAD");
        const tip = piece.slice("HEAD -> ".length).trim();
        if (tip) refs.push(tip);
      } else if (piece === "HEAD") {
        is_head = true;
        refs.push("HEAD");
      } else if (piece.startsWith("tag: ")) {
        refs.push(piece.slice(5).trim());
      } else {
        refs.push(piece);
      }
    }

    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const r of refs) {
      if (r && !seen.has(r)) {
        seen.add(r);
        uniq.push(r);
      }
    }

    commits.push({
      hash: full,
      shortHash: short,
      subject,
      author,
      date: iso,
      refs: uniq,
      isHead: is_head || uniq.includes("HEAD"),
    });
  }

  const branchLabel = await _git_branch_label(repo);
  return json_response({
    isGitRepository: true,
    branch: branchLabel,
    commits,
  });
}

// PORT STATUS: 本文件无 TODO(port)。
