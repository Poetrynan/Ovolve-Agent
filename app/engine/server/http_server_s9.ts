/**
 * http_server_s9.ts — 单元 218 `app/backend/server/http_server.py`（8819 源行）的 **段 S9**。
 * 分段方案 `tmp/w218_SEGMENTS.md` · 契约表 `tmp/w218_SURFACE.md`（本段 = 其 §S9 的 15 行）·
 * 镜像层单一来源 keys.ts §M（上收符号以 `node tmp/lead_mirror_single_source_check.mjs s9` 现查为准，
 *   本文件**全部 import，零私有副本**）。
 *
 * 覆盖源区间 **7491–8051**（commit / push / hooks / evolution / browser handler 簇）：
 *   7491–7526  _wire_scene_callbacks          （模块级 helper）
 *   7528–7547  _llm_callback_for              （模块级 helper）
 *   7549–7581  handle_git_commit_message      GET    /api/git/commit-message          #130
 *   7583–7685  handle_git_commit              POST   /api/git/commit                  #131
 *   7687–7709  handle_git_push                POST   /api/git/push                    #132
 *   7713–7739  handle_get_hooks               GET    /api/hooks                       #137
 *   7741–7747  handle_reload_hooks            POST   /api/hooks/reload                #138
 *   7755–7769  _evolution_workspace_root      （模块级 helper）
 *   7771–7783  handle_evolution_list          GET    /api/evolution/proposals         #144
 *   7785–7803  handle_evolution_list_all      GET    /api/evolution/proposals/all     #145
 *   7805–7826  handle_evolution_observations  GET    /api/evolution/observations      #146
 *   7828–7852  handle_evolution_decide        POST   /api/evolution/proposals/{id}/accept #148
 *                                             POST   /api/evolution/proposals/{id}/reject #149
 *   7854–7860  handle_evolution_mine          POST   /api/evolution/mine              #150
 *   7862–7872  handle_evolution_get_mode      GET    /api/evolution/mode              #151
 *   7874–7895  handle_evolution_set_mode      PUT    /api/evolution/mode              #152
 *   7910–7922  _claim_session_manager         （模块级 helper）
 *   7924–7939  _claim_receipt                 （模块级 helper）
 *   7941–7976  handle_browser_tabs            GET    /api/browser/tabs                #81
 *   7978–8019  handle_browser_claim           POST   /api/browser/claim               #82
 *
 * **计数**：15 条注册 / 14 个 handler（`handle_*`），另 5 个模块级 helper。
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

class PyJSONDecodeErrorP extends PyValueErrorP {
  constructor(message: string) {
    super(message);
    this.pyName = "JSONDecodeError";
    this.name = "JSONDecodeError";
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

// ── S9 Seams ────────────────────────────────────────────────────────────────
export const HTTP_S9_SEAM_KEYS = [
  "session_host_module",
  "model_registry_module",
  "git_trust_module",
  "hook_runner_module",
  "evolution_module",
  "browser_agent_module",
  "browser_sessions_module",
  "subprocess_git_runner",
  "config_persister",
] as const;

export type HttpS9SeamKey = (typeof HTTP_S9_SEAM_KEYS)[number];

const _s9_seams: Record<string, () => any> = {};

export function register_s9_seam<K extends HttpS9SeamKey>(key: K, getter: () => any): void {
  _s9_seams[key] = getter;
}

export function reset_s9_seams_for_probe(): void {
  for (const k of HTTP_S9_SEAM_KEYS) {
    delete _s9_seams[k];
  }
}

function get_seam<K extends HttpS9SeamKey>(key: K): any {
  const fn = _s9_seams[key];
  if (fn) return fn();
  return null;
}

// ── Git & Router Helpers (from S8 contract) ──────────────────────────────────
async function _s9_git_router(request: RequestLike): Promise<any> {
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
      // pass
    }
  }
  return app_state_require(request.app, ROUTER_KEY);
}

async function _s9_git_out(repo: string, args: string[]): Promise<string> {
  const runner = get_seam("subprocess_git_runner");
  if (runner && typeof runner.run_async === "function") {
    const res = await runner.run_async(repo, args, 15);
    if (!res || res.returncode !== 0) return "";
    return (res.stdout || "").replace(/[\r\n]+$/, "");
  }
  return "";
}

async function _s9_git_proc_async(repo: string, args: string[], timeout = 60): Promise<any> {
  const runner = get_seam("subprocess_git_runner");
  if (runner && typeof runner.run_async === "function") {
    return await runner.run_async(repo, args, timeout);
  }
  return { returncode: 1, stdout: "", stderr: "git not available" };
}

async function _s9_resolve_git_repo(
  request: RequestLike
): Promise<[string | null, any, Record<string, unknown> | null]> {
  const router: any = await _s9_git_router(request);
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

  const isInside = (await _s9_git_out(repo, ["rev-parse", "--is-inside-work-tree"])) === "true";
  if (!isInside) {
    return [null, router, { isGitRepository: false, workspaceOpen: true }];
  }

  const toplevel = await _s9_git_out(repo, ["rev-parse", "--show-toplevel"]);
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

// ── Module Helper: _wire_scene_callbacks (7491–7526) ────────────────────────
export function _wire_scene_callbacks(llm: any): { clients: Record<string, any>; models: Record<string, any> } {
  const mr = get_seam("model_registry_module");
  const picks: Record<string, string> = {
    memory: (mr && mr.SCENE_MEMORY_EXTRACT) || "memory",
    goal: (mr && mr.SCENE_GOAL_VERDICT) || "goal",
    commit: (mr && mr.SCENE_COMMIT_MESSAGE) || "commit",
  };
  const out: Record<string, any> = {};
  const clients: Record<string, any> = {};
  for (const [name, scene] of Object.entries(picks)) {
    let client = llm;
    try {
      if (llm && typeof llm.bind_scene === "function") {
        client = llm.bind_scene(scene);
      }
    } catch {
      client = llm;
    }
    clients[name] = client;
    out[name] = client ? client.model_id : null;
  }
  return { clients, models: out };
}

// ── Module Helper: _llm_callback_for (7528–7547) ────────────────────────────
export function _llm_callback_for(router: any, model: string): any {
  const m = py_strip(model);
  const base: any = router ? py_getattr_or(router, "_base_llm", py_getattr_or(router, "llm", null)) : null;
  if (!m || base === null || base === undefined) {
    return null;
  }
  try {
    const mr = get_seam("model_registry_module");
    if (!mr || typeof mr.get_model_registry !== "function") return null;
    const info = mr.get_model_registry().resolve(m);
    if (!info || !info.ok || typeof info.value !== "object" || info.value === null) {
      return null;
    }
    const bound = base.bind ? base.bind(info.value) : base;
    return bound && bound.call ? bound.call.bind(bound) : null;
  } catch {
    return null;
  }
}

// ── Handler 130: handle_git_commit_message (7549–7581) ──────────────────────
export async function handle_git_commit_message(request: RequestLike): Promise<ResponseLike> {
  const [repo, router, err] = await _s9_resolve_git_repo(request);
  if (err !== null) {
    if (!err["workspaceOpen"]) {
      return json_response({ error: "No workspace is open — open a folder first" }, 409);
    }
    return json_response({ error: "Not a git repository" }, 400);
  }
  if (!repo) {
    return json_response({ error: "Not a git repository" }, 400);
  }

  let unstagedRaw = "";
  let modelRaw = "";
  if (request.query) {
    unstagedRaw = py_str(request.query.get("unstaged") || "").toLowerCase();
    modelRaw = py_str(request.query.get("model") || "");
  }
  const include_unstaged = unstagedRaw === "1" || unstagedRaw === "true" || unstagedRaw === "yes";

  const gt = get_seam("git_trust_module");
  if (!gt || typeof gt.get_commit_message_generator !== "function") {
    return json_response({ error: "git_trust generator unavailable" }, 500);
  }
  const generator = gt.get_commit_message_generator();
  const llmCb = _llm_callback_for(router, modelRaw);
  const result = await generator.generate(repo, {
    include_unstaged,
    llm_callback: llmCb,
  });

  if (!result || !result.ok) {
    return json_response({ error: (result && result.error) || "generate failed" }, 400);
  }
  return json_response(result.value);
}

// ── Handler 131: handle_git_commit (7583–7685) ──────────────────────────────
export async function handle_git_commit(request: RequestLike): Promise<ResponseLike> {
  const [repo, router, err] = await _s9_resolve_git_repo(request);
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

  const include_unstaged = Boolean(py_truth(py_dict_get(body, "includeUnstaged", false)));
  const want_push = Boolean(py_truth(py_dict_get(body, "push", false)));
  let message = py_strip(py_str(py_dict_get(body, "message", "")));

  if (include_unstaged) {
    try {
      const add = await _s9_git_proc_async(repo, ["add", "-A"]);
      if (!add || add.returncode !== 0) {
        const errMsg = (add && (add.stderr || add.stdout)) || "git add failed";
        return json_response({ error: errMsg.slice(0, 400) }, 400);
      }
    } catch (e: any) {
      return json_response({ error: exc_str(e) }, 500);
    }
  }

  const diffCached = await _s9_git_out(repo, ["diff", "--cached", "--name-only"]);
  if (!diffCached.trim()) {
    return json_response(
      { error: "没有已暂存的改动可提交。勾选「包含未暂存的更改」，或先暂存文件。" },
      400
    );
  }

  let generated_by: any = null;
  if (!message) {
    const gt = get_seam("git_trust_module");
    if (!gt || typeof gt.get_commit_message_generator !== "function") {
      return json_response({ error: "git_trust generator unavailable" }, 500);
    }
    const modelStr = py_str(py_dict_get(body, "model", ""));
    const drafted = await gt.get_commit_message_generator().generate(repo, {
      llm_callback: _llm_callback_for(router, modelStr),
    });
    if (!drafted || !drafted.ok) {
      return json_response({ error: (drafted && drafted.error) || "draft error" }, 400);
    }
    const val = drafted.value || {};
    message = py_strip(py_str(py_dict_get(val, "message", "")));
    generated_by = py_dict_get(val, "generated_by", null);
    if (!message) {
      return json_response({ error: "无法生成提交信息，请手动填写" }, 400);
    }
  }

  try {
    const commit = await _s9_git_proc_async(repo, ["commit", "-m", message]);
    if (!commit || commit.returncode !== 0) {
      const errMsg = (commit && (commit.stderr || commit.stdout)) || "git commit failed";
      return json_response({ error: errMsg.slice(0, 400) }, 400);
    }
  } catch (e: any) {
    return json_response({ error: exc_str(e) }, 500);
  }

  const head = await _s9_git_out(repo, ["rev-parse", "--short", "HEAD"]);
  let pushed = false;
  let push_error: string | null = null;

  if (want_push) {
    const branch = await _s9_git_out(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const upstream = await _s9_git_out(repo, ["rev-parse", "--abbrev-ref", "HEAD@{upstream}"]);
    const has_upstream = Boolean(upstream);
    const args = has_upstream ? ["push"] : ["push", "-u", "origin", branch];
    try {
      const push = await _s9_git_proc_async(repo, args, 180);
      pushed = Boolean(push && push.returncode === 0);
      if (!pushed) {
        push_error = ((push && (push.stderr || push.stdout)) || "git push failed").slice(0, 400);
      }
    } catch (e: any) {
      push_error = exc_str(e);
    }
  }

  return json_response({
    ok: true,
    hash: head,
    message,
    generatedBy: generated_by,
    pushed,
    pushError: push_error,
  });
}

// ── Handler 132: handle_git_push (7687–7709) ────────────────────────────────
export async function handle_git_push(request: RequestLike): Promise<ResponseLike> {
  const [repo, router, err] = await _s9_resolve_git_repo(request);
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

  const branch = await _s9_git_out(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const upstream = await _s9_git_out(repo, ["rev-parse", "--abbrev-ref", "HEAD@{upstream}"]);
  const has_upstream = Boolean(upstream);
  const args = has_upstream ? ["push"] : ["push", "-u", "origin", branch];

  try {
    const proc = await _s9_git_proc_async(repo, args, 180);
    if (!proc || proc.returncode !== 0) {
      const errMsg = (proc && (proc.stderr || proc.stdout)) || "git push failed";
      return json_response({ error: errMsg.slice(0, 400) }, 400);
    }
  } catch (e: any) {
    return json_response({ error: exc_str(e) }, 500);
  }
  return json_response({ ok: true, branch });
}

// ── Handler 137: handle_get_hooks (7713–7739) ───────────────────────────────
export async function handle_get_hooks(request: RequestLike): Promise<ResponseLike> {
  const hr = get_seam("hook_runner_module");
  if (!hr || typeof hr.get_hook_runner !== "function") {
    return json_response({ error: "hook_runner unavailable" }, 500);
  }
  const runner = hr.get_hook_runner();
  const hookEvents: readonly string[] = hr.HOOK_EVENTS || [];
  const registered: Array<Record<string, unknown>> = [];
  const matchers = (runner && runner.matchers) || {};

  for (const event of hookEvents) {
    const groups = matchers[event] || [];
    for (const group of groups) {
      const hooksList = (group.hooks || []).map((h: any) => ({
        type: h.type,
        command: h.command,
        args: h.args,
        timeoutMs: h.timeout_ms,
      }));
      registered.push({
        event,
        matcher: group.matcher,
        source: group.source,
        hooks: hooksList,
      });
    }
  }

  return json_response({
    enabled: runner.enabled,
    supportedEvents: [...hookEvents],
    configPaths: runner.config_paths ? runner.config_paths() : [],
    registered,
    problems: runner.problems || [],
    recentRuns: runner.log ? runner.log.slice(-50) : [],
  });
}

// ── Handler 138: handle_reload_hooks (7741–7747) ────────────────────────────
export async function handle_reload_hooks(request: RequestLike): Promise<ResponseLike> {
  const hr = get_seam("hook_runner_module");
  if (!hr || typeof hr.get_hook_runner !== "function") {
    return json_response({ error: "hook_runner unavailable" }, 500);
  }
  const runner = hr.get_hook_runner();
  const summary = runner.load ? runner.load() : { ok: true };
  return json_response(summary);
}

// ── Module Helper: _evolution_workspace_root (7755–7769) ────────────────────
export function _evolution_workspace_root(request: RequestLike): string {
  let sid = "";
  if (request.query) {
    sid = request.query.get("session_id") || request.query.get("sessionId") || "";
  }
  if (sid) {
    try {
      const sh = get_seam("session_host_module");
      if (sh && typeof sh.get_session_host === "function") {
        const host = sh.get_session_host();
        if (host && typeof host.get === "function") {
          const r = host.get(sid);
          if (r !== null && r !== undefined) {
            return py_str(py_getattr_or(r, "workspace", ""));
          }
        }
      }
    } catch {
      // pass
    }
  }
  const router: any = app_state_require(request.app, ROUTER_KEY);
  return py_str(py_getattr_or(router, "workspace", ""));
}

// ── Handler 144: handle_evolution_list (7771–7783) ──────────────────────────
export async function handle_evolution_list(request: RequestLike): Promise<ResponseLike> {
  try {
    const evo = get_seam("evolution_module");
    if (!evo || typeof evo.get_evolution_engine !== "function") {
      return json_response({ error: "evolution unavailable" }, 500);
    }
    const engine = evo.get_evolution_engine(_evolution_workspace_root(request));
    return json_response({
      mode: engine.mode,
      proposals: engine.list_open ? engine.list_open() : [],
    });
  } catch (exc: any) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

// ── Handler 145: handle_evolution_list_all (7785–7803) ──────────────────────
export async function handle_evolution_list_all(request: RequestLike): Promise<ResponseLike> {
  try {
    const evo = get_seam("evolution_module");
    if (!evo || typeof evo.get_evolution_engine !== "function") {
      return json_response({ error: "evolution unavailable" }, 500);
    }
    const engine = evo.get_evolution_engine(_evolution_workspace_root(request));
    let limit = 50;
    if (request.query) {
      try {
        limit = parseInt(request.query.get("limit") || "50", 10) || 50;
      } catch {
        limit = 50;
      }
    }
    return json_response({
      proposals: engine.list_all ? engine.list_all({ limit }) : [],
      counts: engine.counts ? engine.counts() : {},
      limit,
    });
  } catch (exc: any) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

// ── Handler 146: handle_evolution_observations (7805–7826) ───────────────────
export async function handle_evolution_observations(request: RequestLike): Promise<ResponseLike> {
  try {
    const evo = get_seam("evolution_module");
    if (!evo || typeof evo.get_evolution_engine !== "function") {
      return json_response({ error: "evolution unavailable" }, 500);
    }
    const engine = evo.get_evolution_engine(_evolution_workspace_root(request));
    let limit = 50;
    if (request.query) {
      try {
        limit = Math.max(1, Math.min(parseInt(request.query.get("limit") || "50", 10) || 50, 200));
      } catch {
        limit = 50;
      }
    }
    const obs = engine.store && engine.store.list_observations ? engine.store.list_observations({ limit }) : [];
    return json_response({
      mode: engine.mode,
      observations: obs,
      limit,
    });
  } catch (exc: any) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

// ── Handler 148 & 149: handle_evolution_decide (7828–7852) ──────────────────
export async function handle_evolution_decide(request: RequestLike): Promise<ResponseLike> {
  const evo = get_seam("evolution_module");
  if (!evo || typeof evo.get_evolution_engine !== "function") {
    return json_response({ error: "evolution unavailable" }, 500);
  }
  const proposalId = request.match_info ? request.match_info.get("id", "") : "";
  const reqPath = py_str((request as any).path || "");
  const accept = reqPath.endsWith("/accept");
  let draft_override = "";
  if (accept) {
    try {
      const body: any = await request.json();
      draft_override = py_str(py_dict_get(body || {}, "draft", ""));
    } catch {
      draft_override = "";
    }
  }
  const engine = evo.get_evolution_engine(_evolution_workspace_root(request));
  const result = engine.decide ? engine.decide(proposalId, { accept, draft_override }) : { status: "missing" };
  const statusCode = result && result.status !== "missing" ? 200 : 404;
  return json_response(result, statusCode);
}

// ── Handler 150: handle_evolution_mine (7854–7860) ──────────────────────────
export async function handle_evolution_mine(request: RequestLike): Promise<ResponseLike> {
  const evo = get_seam("evolution_module");
  if (!evo || typeof evo.get_evolution_engine !== "function") {
    return json_response({ error: "evolution unavailable" }, 500);
  }
  const engine = evo.get_evolution_engine(_evolution_workspace_root(request));
  const made = engine.mine ? engine.mine() : [];
  const created = (made || []).map((p: any) => (p && typeof p.to_dict === "function" ? p.to_dict() : p));
  return json_response({ created });
}

// ── Handler 151: handle_evolution_get_mode (7862–7872) ──────────────────────
export async function handle_evolution_get_mode(request: RequestLike): Promise<ResponseLike> {
  const evo = get_seam("evolution_module");
  if (!evo || typeof evo.get_evolution_engine !== "function") {
    return json_response({ error: "evolution unavailable" }, 500);
  }
  const validModes = evo.VALID_MODES || ["off", "observe", "suggest", "auto"];
  const engine = evo.get_evolution_engine(_evolution_workspace_root(request));
  return json_response({
    mode: engine.mode,
    validModes: [...validModes],
    policy: engine.policy_view ? engine.policy_view() : {},
  });
}

// ── Handler 152: handle_evolution_set_mode (7874–7895) ──────────────────────
export async function handle_evolution_set_mode(request: RequestLike): Promise<ResponseLike> {
  const evo = get_seam("evolution_module");
  if (!evo || typeof evo.get_evolution_engine !== "function") {
    return json_response({ error: "evolution unavailable" }, 500);
  }
  const validModes: readonly string[] = evo.VALID_MODES || ["off", "observe", "suggest", "auto"];
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json_response({ error: "invalid JSON" }, 400);
  }
  const mode = py_str(py_dict_get(body, "mode", ""));
  if (!validModes.includes(mode)) {
    return json_response({ error: `bad mode: ${py_repr(mode)}`, validModes: [...validModes] }, 400);
  }
  const engine = evo.get_evolution_engine(_evolution_workspace_root(request));
  if (engine.set_mode) {
    engine.set_mode(mode);
  }
  if (!SERVER_STATE._CONFIG["evolution"] || typeof SERVER_STATE._CONFIG["evolution"] !== "object") {
    SERVER_STATE._CONFIG["evolution"] = {};
  }
  (SERVER_STATE._CONFIG["evolution"] as Record<string, unknown>)["mode"] = mode;

  const cp = get_seam("config_persister");
  if (cp && typeof cp.persist_config === "function") {
    try {
      cp.persist_config();
    } catch (e: any) {
      return json_response({ error: `could not persist: ${exc_str(e)}` }, 500);
    }
  }
  return json_response({ mode: engine.mode });
}

// ── Module Helper: _claim_session_manager (7910–7922) ───────────────────────
export function _claim_session_manager(): any {
  try {
    const ba = get_seam("browser_agent_module");
    if (ba && typeof ba.get_browser_agent === "function") {
      const agent = ba.get_browser_agent();
      const sessions = agent ? py_getattr_or(agent, "sessions", null) : null;
      if (sessions !== null && sessions !== undefined) {
        return sessions;
      }
    }
  } catch {
    // fallback
  }
  const bs = get_seam("browser_sessions_module");
  if (bs && typeof bs.get_shared_session_manager === "function") {
    return bs.get_shared_session_manager();
  }
  return null;
}

// ── Module Helper: _claim_receipt (7924–7939) ───────────────────────────────
export function _claim_receipt(claim: any): Record<string, unknown> {
  if (claim && typeof claim === "object" && !("object_id" in claim && "kind" in claim)) {
    return claim;
  }
  return {
    object_id: py_str(py_getattr_or(claim, "object_id", "")),
    title_snapshot: py_str(py_getattr_or(claim, "title_snapshot", "")),
    url_snapshot: py_str(py_getattr_or(claim, "url_snapshot", "")),
    kind: py_str(py_getattr_or(claim, "kind", "tab")),
    claimed_at_ms: py_int(py_getattr_or(claim, "claimed_at_ms", 0)),
  };
}

// ── Handler 81: handle_browser_tabs (7941–7976) ─────────────────────────────
export async function handle_browser_tabs(request: RequestLike): Promise<ResponseLike> {
  const bs = get_seam("browser_sessions_module");
  const tabClosed = (bs && bs.TAB_CLOSED) || "closed";
  let rawTaskId = "";
  if (request.query) {
    rawTaskId = request.query.get("task_id") || request.query.get("sessionId") || "";
  }
  const taskId = bs && typeof bs.resolve_task_id === "function" ? bs.resolve_task_id({ task_id: rawTaskId }, {}) : rawTaskId;

  try {
    const mgr = _claim_session_manager();
    if (!mgr || typeof mgr.list_tabs !== "function") {
      return json_response({ ok: true, task_id: taskId, tabs: [] });
    }
    const result = mgr.list_tabs(taskId);
    const tabs: Array<Record<string, unknown>> = [];
    if (result && result.ok) {
      const summary = typeof result.value === "object" && result.value !== null ? result.value : {};
      const activeId = summary.active_tab_id;
      for (const t of summary.tabs || []) {
        if (!t || typeof t !== "object" || t.state === tabClosed) {
          continue;
        }
        tabs.push({
          tab_id: py_str(py_dict_get(t, "tab_id", "")),
          title: py_str(py_dict_get(t, "title", "")),
          url: py_str(py_dict_get(t, "url", "")),
          status: py_str(py_dict_get(t, "state", "")),
          active: t.tab_id === activeId,
        });
      }
    }
    return json_response({ ok: true, task_id: taskId, tabs });
  } catch (exc: any) {
    return json_response({ error: `browser tabs unavailable: ${exc_str(exc)}` }, 500);
  }
}

// ── Handler 82: handle_browser_claim (7978–8019) ────────────────────────────
export async function handle_browser_claim(request: RequestLike): Promise<ResponseLike> {
  const bs = get_seam("browser_sessions_module");
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json_response({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json_response({ error: "body must be a JSON object" }, 400);
  }

  const objectId = py_strip(py_str(py_dict_get(body, "object_id", "")));
  if (!objectId) {
    return json_response({ error: "object_id is required" }, 400);
  }

  let taskId = "";
  if (bs && typeof bs.resolve_task_id === "function") {
    taskId = bs.resolve_task_id({ task_id: py_dict_get(body, "task_id") }, {});
  } else {
    taskId = py_str(py_dict_get(body, "task_id", ""));
  }

  const claim = {
    object_id: objectId,
    title_snapshot: py_str(py_dict_get(body, "title_snapshot", "")),
    url_snapshot: py_str(py_dict_get(body, "url_snapshot", "")),
  };

  try {
    const mgr = _claim_session_manager();
    if (!mgr || typeof mgr.claim_tab !== "function") {
      return json_response({ error: "claim endpoint failure: manager unavailable" }, 500);
    }
    const result = mgr.claim_tab(taskId, claim);
    if (!result || !result.ok) {
      return json_response({ ok: false, message: (result && result.error) || "claim rejected" });
    }
    const val = typeof result.value === "object" && result.value !== null ? result.value : {};
    return json_response({
      ok: true,
      tab: val.tab,
      claim: _claim_receipt(val.claim),
    });
  } catch (exc: any) {
    return json_response({ error: `claim endpoint failure: ${exc_str(exc)}` }, 500);
  }
}

// PORT STATUS: 本文件无 TODO(port)。
