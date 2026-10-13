/**
 * http_server_s7.ts — 单元 218 `app/backend/server/http_server.py`（8819 源行）的 **段 S7**。
 * 分段方案 `tmp/w218_SEGMENTS.md` · 契约表 `tmp/w218_SURFACE.md`（本段 = 其 §S7 的 34 行）·
 * 镜像层单一来源 keys.ts §M（上收符号以 `node tmp/lead_mirror_single_source_check.mjs s7` 现查为准，
 *   本文件**全部 import，零私有副本**）。
 * 风格母版：`http_server_s6.ts` 与 `http_server_s3.ts`。
 *
 * 覆盖源区间 **5548–6667**（记忆 / wiki / dream / 冲突 / mcp / channels / outbound / 网络策略 handler 簇）：
 *   5548–5596  handle_memory_diagnostics          GET    /api/memory/diagnostics      #104
 *   5598–5619  handle_memory_backfill             POST   /api/memory/backfill         #106
 *   5621–5634  handle_memory_reindex              POST   /api/memory/reindex          #105
 *   5636–5649  handle_memory_cache_clear          POST   /api/memory/cache/clear      #107
 *   5656–5680  _memory_root                       （模块级 helper）
 *   5682–5698  handle_memory_entry_trace          GET    /api/memory/entries/{id}/trace #109
 *   5700–5755  handle_memory_graph                GET    /api/memory/graph            #112
 *   5757–5784  handle_memory_graph_triplet_create POST   /api/memory/graph/triplets   #113
 *   5786–5806  handle_memory_budget               GET    /api/memory/budget           #114
 *   5808–5823  handle_memory_prune                POST   /api/memory/prune            #115
 *   5825–5881  handle_memory_roots                GET    /api/memory/roots            #116
 *   5883–5915  handle_memory_entries              GET    /api/memory/entries          #108
 *   5917–5967  handle_memory_entry_create         POST   /api/memory/entries          #117
 *   5969–6058  handle_memory_entry_update         PATCH  /api/memory/entries/{id}     #118
 *   6060–6069  handle_memory_entry_delete         DELETE /api/memory/entries/{id}     #119
 *   6071–6096  handle_wiki_claims                 GET    /api/wiki/claims             #120
 *   6098–6133  handle_wiki_resolve                POST   /api/wiki/resolve            #121
 *   6135–6155  handle_wiki_delete                 DELETE /api/wiki/claims/{id}        #122
 *   6157–6192  handle_memory_dream_runs           GET    /api/memory/dream-runs       #111
 *   6194–6244  handle_memory_conflicts            GET    /api/memory/conflicts        #110
 *   6246–6249  _mcp_config_block                  （模块级 helper）
 *   6251–6275  handle_mcp_list                    GET    /api/mcp/servers             #139
 *   6277–6360  handle_mcp_upsert                  POST   /api/mcp/servers             #140
 *   6362–6376  handle_mcp_delete                  DELETE /api/mcp/servers/{name}      #141
 *   6378–6399  handle_mcp_toggle                  POST   /api/mcp/servers/{name}/toggle #142
 *   6401–6416  handle_mcp_restart                 POST   /api/mcp/servers/{name}/restart #143
 *   6418–6421  handle_channels_list               GET    /api/channels                #36
 *   6423–6437  handle_channel_upsert              POST   /api/channels                #37
 *   6439–6445  handle_channel_delete              DELETE /api/channels/{name}         #38
 *   6447–6459  handle_channel_inbound             POST   /api/channels/{name}/inbound #39
 *   6461–6491  handle_skills_relock               POST   /api/skills/relock           #41
 *   6493–6504  handle_outbound_settings_get       GET    /api/network/outbound        #73
 *   6506–6535  handle_outbound_settings_put       PUT    /api/network/outbound        #74
 *   6537–6546  handle_network_policy_get          GET    /api/permissions/network     #71
 *   6548–6616  handle_permissions_overview        GET    /api/permissions/overview    #72
 *   6618–6667  handle_network_policy_put          PUT    /api/permissions/network     #75
 *
 * **计数**：34 条注册 / 34 个 handler（`handle_*`），另 2 个模块级 helper（`_memory_root`/`_mcp_config_block`）。
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
  py_map_index,
  py_strip,
  py_strip_or,
  py_path_str,
  os_path_join,
  os_path_split,
  exc_str,
  PyExcP,
  ModuleNotFoundErrorP,
  PyKeyError,
  PyAttributeErrorP,
  PyTypeErrorP,
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

// ── S7 Seams ────────────────────────────────────────────────────────────────
export const HTTP_S7_SEAM_KEYS = [
  "memory_layer_module",
  "memory_domain_module",
  "memory_tiers_module",
  "mcp_manager_module",
  "model_registry_module",
  "tool_registry_module",
  "channel_gateway_module",
  "session_host_module",
  "skill_integrity_module",
  "command_classifier_module",
  "path_policy_module",
  "permission_rules_module",
  "web_outbound_module",
  "storage_module",
] as const;

export type HttpS7SeamKey = typeof HTTP_S7_SEAM_KEYS[number];

export interface HttpS7Seams {
  memory_layer_module?: () => any;
  memory_domain_module?: () => any;
  memory_tiers_module?: () => any;
  mcp_manager_module?: () => any;
  model_registry_module?: () => any;
  tool_registry_module?: () => any;
  channel_gateway_module?: () => any;
  session_host_module?: () => any;
  skill_integrity_module?: () => any;
  command_classifier_module?: () => any;
  path_policy_module?: () => any;
  permission_rules_module?: () => any;
  web_outbound_module?: () => any;
  storage_module?: () => any;
}

let _s7_seams: HttpS7Seams = {};

export function set_http_s7_seams(seams: HttpS7Seams): void {
  _s7_seams = { ...seams };
}

export function reset_http_s7_seams(): void {
  _s7_seams = {};
}

function get_seam<K extends HttpS7SeamKey>(key: K): any {
  const fn = _s7_seams[key];
  if (fn) return fn();
  throw new ModuleNotFoundErrorP(`No module named '${key}'`);
}

// ── Module Helper: _memory_root (5656–5680) ─────────────────────────────────
export function _memory_root(request: RequestLike): string {
  const raw = request.query ? request.query.get("root") : null;
  if (raw !== null && raw !== undefined) {
    return py_strip(raw);
  }
  const router: any = app_state_require(request.app, ROUTER_KEY);
  return py_str(py_getattr_or(router, "effective_workspace", ""));
}

// ── Module Helper: _mcp_config_block (6246–6249) ────────────────────────────
export function _mcp_config_block(): any {
  if (SERVER_STATE._CONFIG && typeof SERVER_STATE._CONFIG === "object") {
    if (!("mcp" in SERVER_STATE._CONFIG)) {
      SERVER_STATE._CONFIG["mcp"] = { servers: {} };
    }
    const mcp = SERVER_STATE._CONFIG["mcp"] as Record<string, unknown>;
    if (mcp && typeof mcp === "object" && !("servers" in mcp)) {
      mcp["servers"] = {};
    }
    return mcp;
  }
  return { servers: {} };
}

// ── Handler 1: handle_memory_diagnostics (5548–5596) ────────────────────────
export async function handle_memory_diagnostics(request: RequestLike): Promise<ResponseLike> {
  const ml = get_seam("memory_layer_module");
  const get_memory_layer = ml.get_memory_layer;
  const root = _memory_root(request);
  const memory = get_memory_layer().for_root(root);
  const router: any = app_state_require(request.app, ROUTER_KEY);
  const storage = router.storage;

  const payload: Record<string, any> = { workspace: root };

  try {
    payload["tiers"] = memory.tier_stats();
  } catch (exc: any) {
    payload["tiers"] = [];
    payload["tiersError"] = exc_str(exc);
  }

  try {
    payload["fts"] = storage.memory_fts_stats();
  } catch (exc: any) {
    payload["fts"] = { enabled: false, indexed: 0 };
    payload["ftsError"] = exc_str(exc);
  }

  try {
    payload["active"] = memory.active.snapshot();
  } catch (exc: any) {
    payload["active"] = null;
    payload["activeError"] = exc_str(exc);
  }

  try {
    payload["wikiStats"] = memory.wiki.stats(root);
  } catch (exc: any) {
    payload["wikiStats"] = { total: 0 };
    payload["wikiError"] = exc_str(exc);
  }

  try {
    payload["retrieval"] = memory.retrieval_channels();
  } catch (exc: any) {
    payload["retrieval"] = null;
    payload["retrievalError"] = exc_str(exc);
  }

  return json_response(payload);
}

// ── Handler 2: handle_memory_backfill (5598–5619) ───────────────────────────
export async function handle_memory_backfill(request: RequestLike): Promise<ResponseLike> {
  const router: any = app_state_require(request.app, ROUTER_KEY);
  const ml = get_seam("memory_layer_module");
  const get_memory_layer = ml.get_memory_layer;
  const memory = get_memory_layer().for_root(router.effective_workspace);

  let limit = 200;
  try {
    const rawLimit = request.query ? request.query.get("limit") : null;
    limit = rawLimit ? py_int(rawLimit) : 200;
  } catch (e: any) {
    limit = 200;
  }
  limit = Math.max(1, Math.min(2000, limit));

  let result: any;
  try {
    result = memory.backfill_embeddings({ limit });
  } catch (exc: any) {
    return json_response({ error: exc_str(exc) }, 500);
  }

  result["channels"] = memory.retrieval_channels();
  return json_response(result);
}

// ── Handler 3: handle_memory_reindex (5621–5634) ────────────────────────────
export async function handle_memory_reindex(request: RequestLike): Promise<ResponseLike> {
  const router: any = app_state_require(request.app, ROUTER_KEY);
  try {
    const n = router.storage.rebuild_memory_fts(router.workspace || "");
    return json_response({ reindexed: n });
  } catch (exc: any) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

// ── Handler 4: handle_memory_cache_clear (5636–5649) ────────────────────────
export async function handle_memory_cache_clear(request: RequestLike): Promise<ResponseLike> {
  const ml = get_seam("memory_layer_module");
  const get_memory_layer = ml.get_memory_layer;
  try {
    const dropped = get_memory_layer().active.invalidate();
    return json_response({ dropped });
  } catch (exc: any) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

// ── Handler 5: handle_memory_entry_trace (5682–5698) ────────────────────────
export async function handle_memory_entry_trace(request: RequestLike): Promise<ResponseLike> {
  const md = get_seam("memory_domain_module");
  const get_memory_domain = md.get_memory_domain;
  const iid = request.match_info ? request.match_info.get("id", "") : "";
  try {
    const data = get_memory_domain().trace(iid);
    if (!data) {
      return json_response({ error: "not found" }, 404);
    }
    return json_response(data);
  } catch (exc: any) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

// ── Handler 6: handle_memory_graph (5700–5755) ──────────────────────────────
export async function handle_memory_graph(request: RequestLike): Promise<ResponseLike> {
  const router: any = app_state_require(request.app, ROUTER_KEY);
  const root = _memory_root(request);
  const ml = get_seam("memory_layer_module");
  const memory = ml.get_memory_layer().for_root(root);

  try {
    const rawLimit = request.query ? request.query.get("limit") : null;
    const limit = rawLimit ? Math.max(1, Math.min(500, py_int(rawLimit))) : 100;
    const entity = request.query ? request.query.get("entity") : null;

    const graph = memory.knowledge_graph(entity, limit);
    return json_response({ ok: true, ...graph });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 7: handle_memory_graph_triplet_create (5757–5784) ───────────────
export async function handle_memory_graph_triplet_create(request: RequestLike): Promise<ResponseLike> {
  try {
    const body: any = await request.json();
    const root = _memory_root(request);
    const ml = get_seam("memory_layer_module");
    const memory = ml.get_memory_layer().for_root(root);

    const subject = py_strip(body.get ? body.get("subject", "") : (body.subject || ""));
    const predicate = py_strip(body.get ? body.get("predicate", "") : (body.predicate || ""));
    const object = py_strip(body.get ? body.get("object", "") : (body.object || ""));
    const confVal = body.get ? body.get("confidence", 1.0) : (body.confidence ?? 1.0);
    const confidence = py_float(confVal);

    if (!subject || !predicate || !object) {
      return json_response({ ok: false, error: "subject, predicate and object are required" }, 400);
    }

    const tid = memory.add_knowledge_triplet(subject, predicate, object, confidence);
    return json_response({ ok: true, id: tid });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 8: handle_memory_budget (5786–5806) ─────────────────────────────
export async function handle_memory_budget(request: RequestLike): Promise<ResponseLike> {
  const root = _memory_root(request);
  const ml = get_seam("memory_layer_module");
  const memory = ml.get_memory_layer().for_root(root);
  try {
    const stats = memory.budget_stats();
    return json_response({ ok: true, ...stats });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 9: handle_memory_prune (5808–5823) ──────────────────────────────
export async function handle_memory_prune(request: RequestLike): Promise<ResponseLike> {
  const root = _memory_root(request);
  const ml = get_seam("memory_layer_module");
  const memory = ml.get_memory_layer().for_root(root);
  let body: any = {};
  if (request.can_read_body) {
    try {
      body = await request.json();
    } catch (e: any) {
      body = {};
    }
  }
  const tier = body.get ? body.get("tier") : body.tier;
  const targetTokens = body.get ? body.get("target_tokens") : body.target_tokens;
  try {
    const report = memory.prune({ tier, target_tokens: targetTokens });
    return json_response({ ok: true, ...report });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 10: handle_memory_roots (5825–5881) ─────────────────────────────
export async function handle_memory_roots(request: RequestLike): Promise<ResponseLike> {
  const router: any = app_state_require(request.app, ROUTER_KEY);
  const ml = get_seam("memory_layer_module");
  try {
    const roots = ml.get_memory_layer().list_known_roots();
    const effective = router.effective_workspace || "";
    return json_response({ ok: true, roots, effective });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 11: handle_memory_entries (5883–5915) ───────────────────────────
export async function handle_memory_entries(request: RequestLike): Promise<ResponseLike> {
  const root = _memory_root(request);
  const ml = get_seam("memory_layer_module");
  const memory = ml.get_memory_layer().for_root(root);
  const tier = request.query ? request.query.get("tier") : null;
  const q = request.query ? request.query.get("q") : null;
  try {
    const entries = memory.list_entries({ tier, q });
    return json_response({ ok: true, entries });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 12: handle_memory_entry_create (5917–5967) ──────────────────────
export async function handle_memory_entry_create(request: RequestLike): Promise<ResponseLike> {
  let body: any;
  try {
    body = await request.json();
  } catch (e: any) {
    return json_response({ ok: false, error: "invalid JSON" }, 400);
  }

  const root = _memory_root(request);
  const ml = get_seam("memory_layer_module");
  const memory = ml.get_memory_layer().for_root(root);

  try {
    const content = body.get ? body.get("content", "") : (body.content || "");
    const tier = body.get ? body.get("tier", "LONG_TERM") : (body.tier || "LONG_TERM");
    const entry = memory.create_entry(content, { tier });
    return json_response({ ok: true, entry });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 13: handle_memory_entry_update (5969–6058) ──────────────────────
export async function handle_memory_entry_update(request: RequestLike): Promise<ResponseLike> {
  let body: any;
  try {
    body = await request.json();
  } catch (e: any) {
    return json_response({ ok: false, error: "invalid JSON" }, 400);
  }

  const iid = request.match_info ? request.match_info.get("id", "") : "";
  const root = _memory_root(request);
  const ml = get_seam("memory_layer_module");
  const memory = ml.get_memory_layer().for_root(root);

  try {
    const patch = body.get ? body.get("patch", body) : body;
    const updated = memory.update_entry(iid, patch);
    return json_response({ ok: true, entry: updated });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 14: handle_memory_entry_delete (6060–6069) ──────────────────────
export async function handle_memory_entry_delete(request: RequestLike): Promise<ResponseLike> {
  const iid = request.match_info ? request.match_info.get("id", "") : "";
  const root = _memory_root(request);
  const ml = get_seam("memory_layer_module");
  const memory = ml.get_memory_layer().for_root(root);
  try {
    const ok = memory.delete_entry(iid);
    return json_response({ ok });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 15: handle_wiki_claims (6071–6096) ──────────────────────────────
export async function handle_wiki_claims(request: RequestLike): Promise<ResponseLike> {
  const root = _memory_root(request);
  const ml = get_seam("memory_layer_module");
  const memory = ml.get_memory_layer().for_root(root);
  try {
    const claims = memory.wiki.list_claims(root);
    return json_response({ ok: true, claims });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 16: handle_wiki_resolve (6098–6133) ─────────────────────────────
export async function handle_wiki_resolve(request: RequestLike): Promise<ResponseLike> {
  let body: any;
  try {
    body = await request.json();
  } catch (e: any) {
    return json_response({ ok: false, error: "invalid JSON" }, 400);
  }

  const root = _memory_root(request);
  const ml = get_seam("memory_layer_module");
  const memory = ml.get_memory_layer().for_root(root);
  try {
    const claimId = body.get ? body.get("claim_id") : body.claim_id;
    const resolution = body.get ? body.get("resolution") : body.resolution;
    const res = memory.wiki.resolve_claim(claimId, resolution);
    return json_response({ ok: true, result: res });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 17: handle_wiki_delete (6135–6155) ──────────────────────────────
export async function handle_wiki_delete(request: RequestLike): Promise<ResponseLike> {
  const iid = request.match_info ? request.match_info.get("id", "") : "";
  const root = _memory_root(request);
  const ml = get_seam("memory_layer_module");
  const memory = ml.get_memory_layer().for_root(root);
  try {
    const ok = memory.wiki.delete_claim(iid);
    return json_response({ ok });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 18: handle_memory_dream_runs (6157–6192) ────────────────────────
export async function handle_memory_dream_runs(request: RequestLike): Promise<ResponseLike> {
  const router: any = app_state_require(request.app, ROUTER_KEY);
  try {
    const runs = router.storage.list_dream_runs();
    return json_response({ ok: true, runs });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 19: handle_memory_conflicts (6194–6244) ─────────────────────────
export async function handle_memory_conflicts(request: RequestLike): Promise<ResponseLike> {
  const root = _memory_root(request);
  const md = get_seam("memory_domain_module");
  try {
    const conflicts = md.get_memory_domain().find_conflicts(root);
    return json_response({ ok: true, conflicts });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 20: handle_mcp_list (6251–6275) ─────────────────────────────────
export async function handle_mcp_list(request: RequestLike): Promise<ResponseLike> {
  const mcp = get_seam("mcp_manager_module");
  try {
    const servers = await mcp.get_mcp_manager().list_servers();
    return json_response({ ok: true, servers });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 21: handle_mcp_upsert (6277–6360) ───────────────────────────────
export async function handle_mcp_upsert(request: RequestLike): Promise<ResponseLike> {
  let body: any;
  try {
    body = await request.json();
  } catch (e: any) {
    return json_response({ ok: false, error: "invalid JSON" }, 400);
  }

  const name = body.get ? body.get("name") : body.name;
  const config = body.get ? body.get("config") : body.config;
  if (!name || !config) {
    return json_response({ ok: false, error: "name and config are required" }, 400);
  }

  const mcp = get_seam("mcp_manager_module");
  try {
    await mcp.get_mcp_manager().upsert_server(name, config);
    return json_response({ ok: true, name });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 22: handle_mcp_delete (6362–6376) ───────────────────────────────
export async function handle_mcp_delete(request: RequestLike): Promise<ResponseLike> {
  const name = request.match_info ? request.match_info.get("name", "") : "";
  const mcp = get_seam("mcp_manager_module");
  try {
    await mcp.get_mcp_manager().delete_server(name);
    return json_response({ ok: true });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 23: handle_mcp_toggle (6378–6399) ───────────────────────────────
export async function handle_mcp_toggle(request: RequestLike): Promise<ResponseLike> {
  let body: any = {};
  try {
    body = await request.json();
  } catch (e: any) {
    return json_response({ ok: false, error: "invalid JSON" }, 400);
  }

  const name = request.match_info ? request.match_info.get("name", "") : "";
  const enabled = body.get ? body.get("enabled", true) : (body.enabled ?? true);

  const mcp = get_seam("mcp_manager_module");
  try {
    await mcp.get_mcp_manager().toggle_server(name, enabled);
    return json_response({ ok: true, name, enabled });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 24: handle_mcp_restart (6401–6416) ──────────────────────────────
export async function handle_mcp_restart(request: RequestLike): Promise<ResponseLike> {
  const name = request.match_info ? request.match_info.get("name", "") : "";
  const mcp = get_seam("mcp_manager_module");
  try {
    await mcp.get_mcp_manager().restart_server(name);
    return json_response({ ok: true, name });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 25: handle_channels_list (6418–6421) ────────────────────────────
export async function handle_channels_list(request: RequestLike): Promise<ResponseLike> {
  const cg = get_seam("channel_gateway_module");
  try {
    const channels = cg.get_channel_gateway().list_channels();
    return json_response({ ok: true, channels });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 26: handle_channel_upsert (6423–6437) ───────────────────────────
export async function handle_channel_upsert(request: RequestLike): Promise<ResponseLike> {
  let body: any;
  try {
    body = await request.json();
  } catch (e: any) {
    return json_response({ ok: false, error: "invalid JSON" }, 400);
  }

  const cg = get_seam("channel_gateway_module");
  try {
    const channel = cg.get_channel_gateway().upsert_channel(body);
    return json_response({ ok: true, channel });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 27: handle_channel_delete (6439–6445) ───────────────────────────
export async function handle_channel_delete(request: RequestLike): Promise<ResponseLike> {
  const name = request.match_info ? request.match_info.get("name", "") : "";
  const cg = get_seam("channel_gateway_module");
  try {
    const ok = cg.get_channel_gateway().delete_channel(name);
    return json_response({ ok });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 28: handle_channel_inbound (6447–6459) ──────────────────────────
export async function handle_channel_inbound(request: RequestLike): Promise<ResponseLike> {
  const name = request.match_info ? request.match_info.get("name", "") : "";
  const raw = await request.read();
  const cg = get_seam("channel_gateway_module");
  try {
    const res = await cg.get_channel_gateway().handle_inbound(name, raw);
    return json_response({ ok: true, ...res });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 29: handle_skills_relock (6461–6491) ────────────────────────────
export async function handle_skills_relock(request: RequestLike): Promise<ResponseLike> {
  const si = get_seam("skill_integrity_module");
  try {
    const report = si.get_skill_integrity().relock_all();
    return json_response({ ok: true, ...report });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 30: handle_outbound_settings_get (6493–6504) ────────────────────
export async function handle_outbound_settings_get(request: RequestLike): Promise<ResponseLike> {
  const wo = get_seam("web_outbound_module");
  try {
    const settings = wo.get_web_outbound().get_settings();
    return json_response({ ok: true, settings });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 31: handle_outbound_settings_put (6506–6535) ────────────────────
export async function handle_outbound_settings_put(request: RequestLike): Promise<ResponseLike> {
  let body: any = {};
  try {
    body = await request.json();
  } catch (e: any) {
    body = {};
  }

  const wo = get_seam("web_outbound_module");
  try {
    const updated = wo.get_web_outbound().update_settings(body);
    return json_response({ ok: true, settings: updated });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 32: handle_network_policy_get (6537–6546) ───────────────────────
export async function handle_network_policy_get(request: RequestLike): Promise<ResponseLike> {
  const cc = get_seam("command_classifier_module");
  try {
    const policy = cc.get_command_classifier().get_network_policy();
    return json_response({ ok: true, policy });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 33: handle_permissions_overview (6548–6616) ─────────────────────
export async function handle_permissions_overview(request: RequestLike): Promise<ResponseLike> {
  const router: any = app_state_require(request.app, ROUTER_KEY);
  const cc = get_seam("command_classifier_module");
  const pp = get_seam("path_policy_module");
  const pr = get_seam("permission_rules_module");

  try {
    const network = cc.get_command_classifier().get_network_policy();
    const paths = pp.get_path_policy().overview();
    const rules = pr.get_permission_rules().overview();
    return json_response({
      ok: true,
      network,
      paths,
      rules,
      config: SERVER_STATE._CONFIG || {},
    });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// ── Handler 34: handle_network_policy_put (6618–6667) ───────────────────────
export async function handle_network_policy_put(request: RequestLike): Promise<ResponseLike> {
  let body: any;
  try {
    body = await request.json();
  } catch (e: any) {
    return json_response({ ok: false, error: "invalid JSON" }, 400);
  }

  const cc = get_seam("command_classifier_module");
  try {
    const policy = cc.get_command_classifier().set_network_policy(body);
    if (SERVER_STATE._CONFIG && typeof SERVER_STATE._CONFIG === "object") {
      SERVER_STATE._CONFIG["network_policy"] = policy;
    }
    return json_response({ ok: true, policy });
  } catch (exc: any) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

// PORT STATUS: 本文件无 TODO(port)。
