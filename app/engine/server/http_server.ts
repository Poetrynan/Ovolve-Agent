/**
 * http_server.ts — Complete Unified TypeScript HTTP & WebSocket Server.
 *
 * Assembled from segments S0–S10 according to w218_SEGMENTS.md.
 * Provides HandlerRegistry (155 handlers incl. WebSocketHandler), ROUTE_TABLE execution,
 * native Node.js HTTP + WebSocket server adapter, and run_server lifecycle.
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  APP_KEYS,
  AppState,
  SERVER_STATE,
  WebRequest,
  WebResponse,
  HttpHandler,
  json_response,
  text_response,
  make_headers,
  MutableHeaders,
  JsonDict,
  PyKeyError,
  ServerApp,
} from "./http_server_keys.js";

import {
  ROUTE_TABLE,
  HandlerName,
  HandlerRegistry,
  RouteSpec,
} from "./http_server_create.js";

import {
  cors_middleware,
} from "./http_server_util.js";

import { auth_middleware } from "../api_auth.js";

import { WebSocketHandler } from "./http_server_s1.js";
import { createProductionSeams, NATIVE_WS_CHANNEL } from "./http_server_runtime.js";
import { wireS5S6Seams } from "./seams_s5_s6.js";

import {
  handle_health,
  handle_confirm_goal_stopped,
  handle_migrations_status,
  handle_migrations_retry,
  handle_learning_bundles,
  handle_tool_contracts,
  handle_get_image,
  handle_get_file,
} from "./http_server_s3.js";

import {
  handle_goals,
  handle_create_goal,
  handle_update_goal,
  handle_delete_goal,
  handle_run_goal,
  handle_pause_goal,
  handle_goal_iterations,
  handle_goal_events,
  handle_goal_contract,
  handle_reflections,
  handle_curriculum_gaps,
  handle_skill_patterns,
  handle_evolution_undo,
  handle_evolution_undo_list,
  handle_workflow_schedules_list,
  handle_workflow_schedule_create,
  handle_workflow_schedule_delete,
  handle_crons,
  handle_create_cron,
  handle_update_cron,
  handle_delete_cron,
  handle_bot_messages,
  handle_bot_send,
  handle_bot_config_get,
  handle_bot_config_put,
  handle_bot_status,
  handle_feishu_webhook,
  handle_dingtalk_webhook,
  handle_wecom_webhook,
} from "./http_server_s4.js";

import {
  handle_skills,
  handle_skill_experiences,
  handle_relations,
  handle_approvals_pending,
  handle_session_learning,
  handle_learning_item_action,
  handle_learning_item_trace,
  handle_episodes_list,
  handle_episode_seal,
  handle_history_trace,
  handle_mailbox_list,
  handle_mailbox_drain,
  handle_skill_candidates,
  handle_skill_candidate_create,
  handle_skill_candidate_action,
  handle_import_skill,
  handle_marketplace_catalog,
  handle_uninstall_skill,
  handle_skill_detail,
  handle_install_skill,
  handle_search_sessions,
  handle_vet_skill,
  handle_enable_skill,
  handle_disable_skill,
  handle_plugins,
  handle_import_plugin,
  handle_plugin_enable,
  handle_plugin_disable,
  handle_plugin_remove,
} from "./http_server_s5.js";

import {
  handle_get_settings,
  handle_permission_rules_list,
  handle_permission_rule_create,
  handle_permission_rule_delete,
  handle_models_list,
  handle_models_resolve,
  handle_models_sync_providers,
  handle_update_settings,
  handle_get_tools,
  handle_subagents_list,
  handle_subagent_kill,
  handle_subagents_kill_all,
  handle_subagent_types,
  handle_subagent_type_update,
  handle_rollback_list,
  handle_rollback_apply,
  handle_checkpoints,
  handle_checkpoint_preview,
  handle_checkpoint_label,
  handle_get_events,
  handle_verify_event_chain,
  handle_get_projected_state,
  handle_fork_at_seq,
  handle_get_session_log,
  handle_get_session_transcript,
  handle_get_session_log_info,
  handle_artifacts,
  handle_usage_stats,
  handle_token_analytics,
} from "./http_server_s6.js";

import {
  handle_memory_diagnostics,
  handle_memory_backfill,
  handle_memory_reindex,
  handle_memory_cache_clear,
  handle_memory_entry_trace,
  handle_memory_graph,
  handle_memory_graph_triplet_create,
  handle_memory_budget,
  handle_memory_prune,
  handle_memory_roots,
  handle_memory_entries,
  handle_memory_entry_create,
  handle_memory_entry_update,
  handle_memory_entry_delete,
  handle_wiki_claims,
  handle_wiki_resolve,
  handle_wiki_delete,
  handle_memory_dream_runs,
  handle_memory_conflicts,
  handle_mcp_list,
  handle_mcp_upsert,
  handle_mcp_delete,
  handle_mcp_toggle,
  handle_mcp_restart,
  handle_channels_list,
  handle_channel_upsert,
  handle_channel_delete,
  handle_channel_inbound,
  handle_skills_relock,
  handle_outbound_settings_get,
  handle_outbound_settings_put,
  handle_network_policy_get,
  handle_permissions_overview,
  handle_network_policy_put,
} from "./http_server_s7.js";

import {
  handle_shadow_status,
  handle_shadow_validate,
  handle_shadow_apply,
  handle_shadow_discard,
  handle_git_status,
  handle_git_diff,
  handle_git_branches,
  handle_git_restore,
  handle_git_checkout,
  handle_git_create_branch,
  handle_git_log,
} from "./http_server_s8.js";

import {
  handle_git_commit_message,
  handle_git_commit,
  handle_git_push,
  handle_get_hooks,
  handle_reload_hooks,
  handle_evolution_list,
  handle_evolution_list_all,
  handle_evolution_observations,
  handle_evolution_decide,
  handle_evolution_mine,
  handle_evolution_get_mode,
  handle_evolution_set_mode,
  handle_browser_tabs,
  handle_browser_claim,
} from "./http_server_s9.js";

/**
 * Build the full HandlerRegistry wiring all 155 handlers from S1–S9.
 */
export function buildHandlerRegistry(wsHandler?: WebSocketHandler): HandlerRegistry {
  return {
    handle_health,
    handle_confirm_goal_stopped,
    handle_migrations_status,
    handle_migrations_retry,
    handle_learning_bundles,
    handle_tool_contracts,
    handle_get_image,
    handle_get_file,
    handle_goals,
    handle_create_goal,
    handle_update_goal,
    handle_delete_goal,
    handle_run_goal,
    handle_pause_goal,
    handle_goal_iterations,
    handle_goal_events,
    handle_goal_contract,
    handle_reflections,
    handle_curriculum_gaps,
    handle_skill_patterns,
    handle_evolution_undo,
    handle_evolution_undo_list,
    handle_workflow_schedules_list,
    handle_workflow_schedule_create,
    handle_workflow_schedule_delete,
    handle_crons,
    handle_create_cron,
    handle_update_cron,
    handle_delete_cron,
    handle_bot_messages,
    handle_bot_send,
    handle_bot_config_get,
    handle_bot_config_put,
    handle_bot_status,
    handle_feishu_webhook,
    handle_dingtalk_webhook,
    handle_wecom_webhook,
    handle_skills,
    handle_skill_experiences,
    handle_relations,
    handle_approvals_pending,
    handle_session_learning,
    handle_learning_item_action,
    handle_learning_item_trace,
    handle_episodes_list,
    handle_episode_seal,
    handle_history_trace,
    handle_mailbox_list,
    handle_mailbox_drain,
    handle_skill_candidates,
    handle_skill_candidate_create,
    handle_skill_candidate_action,
    handle_import_skill,
    handle_marketplace_catalog,
    handle_uninstall_skill,
    handle_skill_detail,
    handle_install_skill,
    handle_search_sessions,
    handle_vet_skill,
    handle_enable_skill,
    handle_disable_skill,
    handle_plugins,
    handle_import_plugin,
    handle_plugin_enable,
    handle_plugin_disable,
    handle_plugin_remove,
    handle_get_settings,
    handle_permission_rules_list,
    handle_permission_rule_create,
    handle_permission_rule_delete,
    handle_models_list,
    handle_models_resolve,
    handle_models_sync_providers,
    handle_update_settings,
    handle_get_tools,
    handle_subagents_list,
    handle_subagent_kill,
    handle_subagents_kill_all,
    handle_subagent_types,
    handle_subagent_type_update,
    handle_rollback_list,
    handle_rollback_apply,
    handle_checkpoints,
    handle_checkpoint_preview,
    handle_checkpoint_label,
    handle_get_events,
    handle_verify_event_chain,
    handle_get_projected_state,
    handle_fork_at_seq,
    handle_get_session_log,
    handle_get_session_transcript,
    handle_get_session_log_info,
    handle_artifacts,
    handle_usage_stats,
    handle_token_analytics,
    handle_memory_diagnostics,
    handle_memory_backfill,
    handle_memory_reindex,
    handle_memory_cache_clear,
    handle_memory_entry_trace,
    handle_memory_graph,
    handle_memory_graph_triplet_create,
    handle_memory_budget,
    handle_memory_prune,
    handle_memory_roots,
    handle_memory_entries,
    handle_memory_entry_create,
    handle_memory_entry_update,
    handle_memory_entry_delete,
    handle_wiki_claims,
    handle_wiki_resolve,
    handle_wiki_delete,
    handle_memory_dream_runs,
    handle_memory_conflicts,
    handle_mcp_list,
    handle_mcp_upsert,
    handle_mcp_delete,
    handle_mcp_toggle,
    handle_mcp_restart,
    handle_channels_list,
    handle_channel_upsert,
    handle_channel_delete,
    handle_channel_inbound,
    handle_skills_relock,
    handle_outbound_settings_get,
    handle_outbound_settings_put,
    handle_network_policy_get,
    handle_permissions_overview,
    handle_network_policy_put,
    handle_shadow_status,
    handle_shadow_validate,
    handle_shadow_apply,
    handle_shadow_discard,
    handle_git_status,
    handle_git_diff,
    handle_git_branches,
    handle_git_restore,
    handle_git_checkout,
    handle_git_create_branch,
    handle_git_log,
    handle_git_commit_message,
    handle_git_commit,
    handle_git_push,
    handle_get_hooks,
    handle_reload_hooks,
    handle_evolution_list,
    handle_evolution_list_all,
    handle_evolution_observations,
    handle_evolution_decide,
    handle_evolution_mine,
    handle_evolution_get_mode,
    handle_evolution_set_mode,
    handle_browser_tabs,
    handle_browser_claim,
    handle_websocket: (req: WebRequest): Promise<WebResponse> => {
      if (wsHandler) {
        return (wsHandler.handle_websocket(req) as unknown) as Promise<WebResponse>;
      }
      return Promise.resolve(json_response({ ok: false, error: "WebSocket handler not initialized" }, 501));
    },
  };
}

/** Precompiled route pattern for URL routing */
interface CompiledRoute {
  readonly spec: RouteSpec;
  readonly regex: RegExp;
  readonly paramNames: string[];
}

/** Pre-compile ROUTE_TABLE into fast regex matchers */
export function compileRoutes(routes: readonly RouteSpec[]): CompiledRoute[] {
  return routes.map((spec) => {
    const paramNames: string[] = [];
    // Convert e.g. /api/goals/{id} to ^/api/goals/([^/]+)$
    const escaped = spec.p.replace(/\{([^}]+)\}/g, (_m, param) => {
      paramNames.push(param);
      return "([^/]+)";
    });
    const regex = new RegExp("^" + escaped + "$");
    return { spec, regex, paramNames };
  });
}

/**
 * Handle incoming Node HTTP request, bridge to WebRequest, invoke handler, write WebResponse.
 */
export async function dispatchNodeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  compiledRoutes: readonly CompiledRoute[],
  registry: HandlerRegistry,
  appState: AppState,
  distDir?: string,
): Promise<void> {
  const reqUrl = req.url || "/";
  const parsed = new url.URL(reqUrl, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = parsed.pathname;
  const method = (req.method || "GET").toUpperCase();

  // Handle CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Api-Token, Authorization",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  // Find matching route
  let matched: CompiledRoute | undefined;
  const matchInfoParams: Record<string, string> = {};

  for (const cr of compiledRoutes) {
    if (cr.spec.m === method) {
      const m = cr.regex.exec(pathname);
      if (m) {
        matched = cr;
        for (let i = 0; i < cr.paramNames.length; i++) {
          const pName = cr.paramNames[i];
          if (pName && m[i + 1] !== undefined) {
            matchInfoParams[pName] = decodeURIComponent(m[i + 1]!);
          }
        }
        break;
      }
    }
  }

  // If no API route matched, check static asset serving if distDir provided
  if (!matched) {
    if (distDir && fs.existsSync(distDir)) {
      let filePath: string | null = null;
      if (pathname === "/" || pathname === "/index.html") {
        filePath = path.join(distDir, "index.html");
      } else if (pathname.startsWith("/assets/")) {
        filePath = path.join(distDir, pathname.slice(1));
      } else {
        const potential = path.join(distDir, pathname.slice(1));
        if (fs.existsSync(potential) && fs.statSync(potential).isFile()) {
          filePath = potential;
        } else {
          filePath = path.join(distDir, "index.html");
        }
      }
      if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimes: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
        };
        res.writeHead(200, {
          "Content-Type": mimes[ext] || "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    res.writeHead(404, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ error: "Not Found", path: pathname, method }));
    return;
  }

  // Read request body
  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(chunk as Buffer);
  }
  const rawBody = Buffer.concat(bodyChunks);

  // Wrap query view
  const queryMap: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => {
    queryMap[k] = v;
  });

  // Wrap headers view
  const reqHeaders = new Map<string, string>();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") reqHeaders.set(k.toLowerCase(), v);
    else if (Array.isArray(v)) reqHeaders.set(k.toLowerCase(), v.join(", "));
  }

  // Authenticate API request
  const authReq = {
    method,
    path: pathname,
    headers: req.headers as Record<string, string | undefined>,
    query: queryMap,
  };
  const authResp = auth_middleware(authReq);
  if (authResp) {
    res.writeHead(authResp.status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Api-Token, Authorization",
    });
    res.end(JSON.stringify(authResp.body));
    return;
  }

  // Build WebRequest adhering to http_server_keys.ts:WebRequest
  const webReq: WebRequest = {
    method,
    path: pathname,
    headers: {
      get(name: string, fallback = ""): string {
        return reqHeaders.get(name.toLowerCase()) ?? fallback;
      },
      items(): Array<[string, string]> {
        return [...reqHeaders.entries()];
      },
    },
    query: {
      get(name: string, fallback = ""): string {
        return queryMap[name] ?? fallback;
      },
      toDict(): JsonDict {
        return { ...queryMap };
      },
    },
    match_info: {
      get(name: string, fallback = ""): string {
        return matchInfoParams[name] ?? fallback;
      },
      index(name: string): string {
        if (!(name in matchInfoParams)) {
          throw new PyKeyError(name);
        }
        return matchInfoParams[name]!;
      },
    },
    app: {
      state: appState,
      get(k: any): any {
        const val = appState.get(k);
        if (val !== null && val !== undefined) return val;
        if (k && typeof k === "object" && k.name) {
          for (const [keyObj, value] of (appState as any).map.entries()) {
            if (keyObj && keyObj.name === k.name) return value;
          }
        }
        if (typeof k === "string") {
          for (const [keyObj, value] of (appState as any).map.entries()) {
            if (keyObj && keyObj.name === k) return value;
          }
        }
        return undefined;
      },
    } as unknown as ServerApp,
    can_read_body: rawBody.length > 0,
    json: async (): Promise<JsonDict> => {
      if (rawBody.length === 0) return {};
      return JSON.parse(rawBody.toString("utf8")) as JsonDict;
    },
    read: async (): Promise<Uint8Array> => {
      return new Uint8Array(rawBody);
    },
  };

  try {
    const handler = registry[matched.spec.h];
    if (!handler) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Handler ${matched.spec.h} not registered` }));
      return;
    }

    const response: WebResponse = await handler(webReq);

    const outHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Api-Token, Authorization",
    };
    for (const [k, v] of response.headers.items()) {
      outHeaders[k] = v;
    }

    if (response.kind === "json") {
      outHeaders["Content-Type"] = "application/json";
      res.writeHead(response.status, outHeaders);
      res.end(JSON.stringify(response.body));
    } else if (response.kind === "text") {
      outHeaders["Content-Type"] = response.contentType || "text/plain; charset=utf-8";
      res.writeHead(response.status, outHeaders);
      res.end(response.text ?? "");
    } else if (response.kind === "file") {
      if (response.path && fs.existsSync(response.path)) {
        res.writeHead(response.status, outHeaders);
        fs.createReadStream(response.path).pipe(res);
      } else {
        res.writeHead(404, outHeaders);
        res.end("File Not Found");
      }
    } else {
      res.writeHead(response.status, outHeaders);
      res.end();
    }
  } catch (err: any) {
    console.error("[server] Handler error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
}

/**
 * RFC 6455 Minimal Native Node WebSocket Adapter for WebSocketHandler
 */
export function handleNativeWebSocketUpgrade(
  req: http.IncomingMessage,
  socket: any,
  wsHandler: WebSocketHandler,
  appState: AppState,
): void {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const incomingQueue: Array<{ type: "TEXT"; data: string }> = [];
  let queueResolver: (() => void) | null = null;
  let closed = false;

  function pushMessage(text: string) {
    incomingQueue.push({ type: "TEXT", data: text });
    if (queueResolver) {
      const r = queueResolver;
      queueResolver = null;
      r();
    }
  }

  // Parse frames
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const byte1 = buffer[0]!;
      const byte2 = buffer[1]!;
      const opcode = byte1 & 0x0f;
      const masked = Boolean(byte2 & 0x80);
      let payloadLen = byte2 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < offset + 2) break;
        payloadLen = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (buffer.length < offset + 8) break;
        payloadLen = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey: Buffer | null = null;
      if (masked) {
        if (buffer.length < offset + 4) break;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + payloadLen) break;

      const payload = buffer.subarray(offset, offset + payloadLen);
      buffer = buffer.subarray(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = (payload[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
        }
      }

      if (opcode === 0x1) {
        // Text
        pushMessage(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        // Close
        closed = true;
        socket.end();
        break;
      } else if (opcode === 0x9) {
        // Ping -> Pong
        const pong = Buffer.from([0x8a, 0x00]);
        socket.write(pong);
      }
    }
  });

  socket.on("close", () => {
    closed = true;
    if (queueResolver) {
      const r = queueResolver;
      queueResolver = null;
      r();
    }
  });

  socket.on("error", () => {
    closed = true;
    socket.destroy();
  });

  // Client adapter matching WebSocketResponseApi
  const clientAdapter = {
    async prepare(_request: unknown): Promise<void> {},
    async send_json(data: unknown): Promise<void> {
      if (closed || !socket.writable) return;
      const str = JSON.stringify(data);
      const strBuf = Buffer.from(str, "utf8");
      let header: Buffer;
      if (strBuf.length < 126) {
        header = Buffer.from([0x81, strBuf.length]);
      } else if (strBuf.length <= 65535) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(strBuf.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(strBuf.length), 2);
      }
      socket.write(Buffer.concat([header, strBuf]));
    },
    async *messages() {
      while (!closed) {
        if (incomingQueue.length > 0) {
          yield incomingQueue.shift()!;
        } else {
          await new Promise<void>((resolve) => {
            queueResolver = resolve;
          });
        }
      }
    },
    exception(): unknown {
      return null;
    },
  };

  const parsedUrl = new url.URL(req.url || "/ws", `http://${req.headers.host || "127.0.0.1"}`);
  const webReq: WebRequest = {
    method: "GET",
    path: parsedUrl.pathname,
    headers: {
      get(n: string, fb = "") {
        const val = req.headers[n.toLowerCase()];
        return (typeof val === "string" ? val : Array.isArray(val) ? val.join(", ") : fb);
      },
      items() {
        return Object.entries(req.headers).map(([k, v]) => [k, typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : ""]);
      },
    },
    query: {
      get(n: string, fb = "") {
        return parsedUrl.searchParams.get(n) ?? fb;
      },
      toDict() {
        const q: Record<string, string> = {};
        parsedUrl.searchParams.forEach((v, k) => { q[k] = v; });
        return q;
      },
    },
    match_info: {
      get(_n: string, fb = "") {
        return fb;
      },
      index(n: string) {
        throw new PyKeyError(n);
      },
    },
    app: { state: appState },
    can_read_body: false,
    json: async () => ({}),
    read: async () => new Uint8Array(),
  };

  // The session loop asks its seam for a websocket response and binds it to
  // this request; park the frame adapter where that seam looks for it.
  (webReq as unknown as Record<PropertyKey, unknown>)[NATIVE_WS_CHANNEL] = clientAdapter;

  // Launch session loop in background
  wsHandler.handle_websocket(webReq as any).catch((e) => {
    console.error("[server:ws] Session loop closed:", e?.message);
  });
}

/**
 * Lines `git diff --numstat` would report for a brand-new file: every record
 * separated by `\n`, with no phantom last line for a trailing newline.
 */
function count_added_lines(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

/** Read at most `capBytes` from a file; unreadable files count as empty. */
function read_capped(file: string, capBytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(capBytes);
    const n = fs.readSync(fd, buf, 0, capBytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Untracked roll-up across many files, bounded by count and bytes. */
function untracked_additions(
  repo: string,
  paths: string[],
  capFiles: number,
  capBytes: number,
): number {
  let total = 0;
  for (const p of paths.slice(0, capFiles)) {
    total += count_added_lines(read_capped(path.join(repo, p), capBytes));
  }
  return total;
}

/** Same roll-up, but every path keeps its own count. */
function untracked_additions_detailed(
  repo: string,
  paths: string[],
  capFiles: number,
  capBytes: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of paths.slice(0, capFiles)) {
    out[p] = count_added_lines(read_capped(path.join(repo, p), capBytes));
  }
  return out;
}

/**
 * Connect all native engine sub-systems to S7-S9 handler seams.
 */
export async function wireDefaultSeams(sessionHost?: any): Promise<void> {
  try {
    const evolution = await import("../evolution.js");
    const modelRegistry = await import("../model_registry.js");
    const modelRegistryImpl = await import("../model_registry_impl.js");
    const mcpManager = await import("../mcp_manager.js");
    const memoryLayer = await import("../memory_layer.js");
    const memoryDomain = await import("../memory_domain.js");
    const memoryTiers = await import("../memory_tiers.js");
    const gitTrust = await import("../git_trust.js");
    const hookRunner = await import("../hook_runner.js");
    const browserAgent = await import("../browser_agent.js");
    const browserSessions = await import("../browser_sessions.js");
    const shadowSession = await import("../shadow_session.js");
    const shadowWorkspace = await import("../shadow_workspace.js");
    const skillIntegrity = await import("../skill_integrity.js");
    const commandClassifier = await import("../command_classifier.js");
    const pathPolicy = await import("../path_policy.js");
    const permissionRules = await import("../permission_rules.js");
    const webOutbound = await import("../web_outbound.js");
    const storage = await import("../storage.js");
    const sessionHostModule = await import("../session_host.js");
    const { git: runGitSync } = await import("../session_worktree.js");
    const { execFile } = await import("node:child_process");

    const { register_s9_seam } = await import("./http_server_s9.js");
    const { register_s8_seam } = await import("./http_server_s8.js");
    const { set_http_s7_seams } = await import("./http_server_s7.js");

    const mrCombined = { ...modelRegistry, ...modelRegistryImpl };

    register_s9_seam("evolution_module", () => evolution);
    register_s9_seam("session_host_module", () => sessionHostModule);
    register_s9_seam("model_registry_module", () => mrCombined);
    register_s9_seam("git_trust_module", () => gitTrust);
    register_s9_seam("hook_runner_module", () => hookRunner);
    register_s9_seam("browser_agent_module", () => browserAgent);
    register_s9_seam("browser_sessions_module", () => browserSessions);

    register_s8_seam("session_host_module", () => sessionHostModule);
    register_s8_seam("shadow_session_module", () => shadowSession);
    register_s8_seam("shadow_workspace_module", () => shadowWorkspace);
    register_s8_seam("subprocess_git_runner", () => ({
      run: (repo: string, args: string[], timeout: number) => {
        const r = runGitSync(repo, args, timeout);
        return { returncode: r.code, stdout: r.stdout, stderr: r.stderr };
      },
      run_async: (repo: string, args: string[], timeout: number) =>
        new Promise((resolve) => {
          execFile(
            "git",
            args,
            {
              cwd: repo,
              timeout: Math.max(1, Number(timeout) || 1) * 1000,
              maxBuffer: 16 * 1024 * 1024,
              windowsHide: true,
            },
            (err, stdout, stderr) => {
              const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number"
                ? ((err as { code: number }).code)
                : -1;
              resolve({ returncode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            },
          );
        }),
      // `.git` is a directory in a checkout and a file in a linked worktree;
      // either one means this path is a working tree we can read.
      has_git_dir: (repo: string) => {
        try {
          return fs.existsSync(path.join(repo, ".git"));
        } catch {
          return false;
        }
      },
    }));
    register_s8_seam("fs_reader", () => ({ untracked_additions, untracked_additions_detailed }));

    set_http_s7_seams({
      memory_layer_module: () => memoryLayer,
      memory_domain_module: () => memoryDomain,
      memory_tiers_module: () => memoryTiers,
      mcp_manager_module: () => mcpManager,
      model_registry_module: () => mrCombined,
      session_host_module: () => sessionHostModule,
      skill_integrity_module: () => skillIntegrity,
      command_classifier_module: () => commandClassifier,
      path_policy_module: () => pathPolicy,
      permission_rules_module: () => permissionRules,
      web_outbound_module: () => webOutbound,
      storage_module: () => storage,
    });
  } catch (err) {
    console.warn("[server] Notice: some seam modules could not be pre-wired:", err);
  }
}

/**
 * Start Ovolve Native TypeScript HTTP & WebSocket Server.
 */
export async function run_server(
  config: JsonDict,
  systemPrompt?: string,
  configPath?: string,
): Promise<http.Server> {
  SERVER_STATE._CONFIG = config;
  SERVER_STATE._CONFIG_PATH = configPath || "";

  const host = String((config["server"] as JsonDict)?.["host"] || "127.0.0.1");
  const envPort = process.env["OVOLVE_SERVER_PORT"];
  const port = envPort ? parseInt(envPort, 10) : Number((config["server"] as JsonDict)?.["port"] || 8765);

  const wsRoot = String((config["workspace"] as JsonDict)?.["root"] || ".");
  if (wsRoot && !fs.existsSync(wsRoot)) {
    try {
      fs.mkdirSync(wsRoot, { recursive: true });
    } catch (_) {}
  }

  // AppState setup
  const appState = new AppState();

  // Lazy-load sub-agents and capability modules
  const { Router } = await import("../router.js");
  const { SessionHost, set_session_host, SESSION_HOST_SEAMS } = await import("../session_host.js");
  const { init_risk_controller } = await import("../risk_control.js");

  // Sessions opened after boot build their own Router lazily; the host needs
  // the real constructor for that.
  SESSION_HOST_SEAMS.Router = Router as unknown as typeof SESSION_HOST_SEAMS.Router;

  const permMode = (config["permissions"] as JsonDict)?.["mode"] || "auto";
  init_risk_controller(String(permMode));

  const router = new Router({
    workspace: wsRoot,
    system_prompt: systemPrompt || "",
  });

  const sessionHost = new SessionHost(systemPrompt || "", wsRoot);
  (sessionHost as any)._sessions.set(router.session_id, router);
  (sessionHost as any)._shared_mounted = true;
  sessionHost.rotate_generation();
  set_session_host(sessionHost);

  // Wire module seams for S5-S9 routes
  await wireS5S6Seams();
  await wireDefaultSeams(sessionHost);

  // Store in AppState
  appState.set(APP_KEYS.ROUTER_KEY, router as any);
  appState.set(APP_KEYS.SESSION_HOST_KEY, sessionHost as any);

  // Initialize WebSocketHandler
  const wsSeams = await createProductionSeams();
  const wsHandler = new WebSocketHandler(sessionHost as any, wsSeams);

  // Compile routes and build registry
  const compiledRoutes = compileRoutes(ROUTE_TABLE);
  const registry = buildHandlerRegistry(wsHandler);

  // Locate UI dist if built
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const possibleDist = path.resolve(__dirname, "../../../dist");

  const server = http.createServer((req, res) => {
    dispatchNodeRequest(req, res, compiledRoutes, registry, appState, possibleDist);
  });

  server.on("upgrade", (req, socket) => {
    if (req.url === "/ws" || req.url?.startsWith("/ws")) {
      // A WebSocket handshake is an ordinary GET, so it goes through the same
      // token check as every other route. The renderer cannot set headers on a
      // socket, hence the `?token=` fallback in extract_token.
      const parsedUrl = new URL(req.url, "http://127.0.0.1");
      const wsQuery: Record<string, string> = {};
      parsedUrl.searchParams.forEach((v, k) => {
        wsQuery[k] = v;
      });
      const wsAuth = auth_middleware({
        method: "GET",
        path: parsedUrl.pathname,
        headers: req.headers as Record<string, string | undefined>,
        query: wsQuery,
      });
      if (wsAuth) {
        const body = JSON.stringify(wsAuth.body);
        socket.write(
          `HTTP/1.1 ${wsAuth.status} Unauthorized\r\n` +
            "Content-Type: application/json\r\n" +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            "Connection: close\r\n\r\n" +
            body,
        );
        socket.destroy();
        return;
      }
      handleNativeWebSocketUpgrade(req, socket, wsHandler, appState);
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      console.log(`[server] Ovolve Native TypeScript Backend listening on http://${host}:${port}`);
      console.log(`[server] WebSocket active at ws://${host}:${port}/ws`);
      resolve();
    });
    server.once("error", reject);
  });

  return server;
}
