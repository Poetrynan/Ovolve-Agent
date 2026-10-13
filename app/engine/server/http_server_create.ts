/**
 * http_server_create.ts — 单元 218 `app/backend/server/http_server.py`（8819 源行）
 * 的 **S0 产物 3/4：骨架（只有骨架，零 handler 正文）**。
 *
 * 源范围：8131–8609（`async def create_server`）——本文件把它拆成两件可编译的东西：
 *   1. `ROUTE_TABLE`（8222–8423 的 160 条注册，**顺序即匹配优先级**）
 *      每条带 `seg`（所属段）/ `src`（源行）/ `parse`（请求体解析姿势）/ `seams`（要用的口子）
 *   2. `HandlerName`（155 个 handler 名的字面量联合）+ `HandlerRegistry`
 *      = `Record<HandlerName, HttpHandler>` —— **S10 少给一个名字就编译不过**，
 *      所以 S0 不需要（也不允许）写任何空函数体来"占位"。
 *   3. `create_server` / `run_server` 的 **seam 声明**（§C / §R）+ 每条 fail-open 臂
 *      的 **逐字 print 文本**（§B：这些 print 就是那些臂的唯一可见输出，
 *      抄错一个字就是行为差异）。
 *
 * S0 的边界（越界即返工）：
 *   - 本文件 **没有任何 handler 正文**；handler 正文分属 S1/S3–S9（见 `seg` 列）。
 *   - 本文件 **不实现** `createServer()`：§C 声明它的参数与 seams 形状，实现归 S10。
 *   - 红线：不绑端口、不起服务、不碰真 SQLite。`web.AppRunner/TCPSite/site.start()`
 *     （8438–8441）与 `await asyncio.Event().wait()`（8606）、`asyncio.run(...)`（8796）
 *     在 §C/§R 里只能是 seam。
 *
 * ⚠️ 与 keys.ts 头同一条陷阱，这里再念一次（S1–S10 都会路过这个文件）：
 *   `app[ROUTER_KEY]` 与 `app["router"]` 在 aiohttp 里是**两个不同的键**（AppKey 按对象
 *   身份相等）。本表里 160 条路由的 handler 一共 31 处读写这两个键（23 处 `app[KEY]`
 *   下标读、4 处 `app.get(KEY)`、2 处 `SESSION_HOST_KEY` 读、2 处写 8184/8185），
 *   必须全部走 keys.ts 导出的 `ROUTER_KEY` / `SESSION_HOST_KEY` + `AppState`。
 *   见 `tmp/w218_S0_NOTES.md` §1.1。
 *
 * 命名差（唯一一处）：源 8224 注册的是 `ws_handler.handle_websocket`（S1 的
 * `WebSocketHandler` 实例方法）。本表把它收成 `h: "handle_websocket"`，
 * S10 装配时负责绑到实例（`ws_handler.handle_websocket.bind(...)` 的 TS 等价物）。
 *
 * 死路径登记（照抄不修，详见 NOTES §2）：B11（8205–8220 三条清理臂 `except: pass`
 * 一行日志不留）、B12（8435 lambda 注册 + 8436 `name='assets'`：seam 收 name 但不
 * 产生第二套路径匹配）、B14（`handle_memory_graph_triplet_create` 整函数 try，
 * 坏 body 落成 500 而非 400）、B7（8620 端口 env 名写两遍）。
 *
 * DIVERGENCE(port)：
 *   D1 源里 `app.add_routes([...])` 接受 aiohttp 的 `web.get(...)` 路由对象；端口把它
 *      变成纯数据 `ROUTE_TABLE` + §C 的 `register_routes` seam，匹配语义（先注册先匹配、
 *      字面量优先于同名参数段）由 `REGISTER_ORDER_TRAPS` 显式携带，不给端口"重排的自由"。
 *   D2 `create_server` 是协程；端口 `CreateServerFn` 返回 Promise。首个挂起点之前
 *      （8139–8150 的 SessionHost 构造/私有字段写/rotate_generation）两侧同步执行，
 *      与 python 一致；差异只剩"同步前缀抛错"在 JS 里是 rejected promise，§C 的
 *      `session_host_ctor` 等三臂因此**不带 try**——与源 8139–8150 一致（唯一的硬依赖）。
 *   D3 8606 `await asyncio.Event().wait()` 永不 resolve：端口用 `wait_forever()` seam
 *      表示"到这里就该停住"，探针注入立刻 resolve 的假件才能遍历后续臂。等价性：
 *      源里 `create_server` 之后的代码在真实运行里根本执行不到，端口的可测性来自注入，
 *      不来自改写。
 */

import type { AppState, HttpHandler, HttpMiddleware, JsonDict, WebRequest, WebResponse } from "./http_server_keys.js";
import { APP_KEYS, SERVER_STATE, py_dict_get, py_int, py_truth } from "./http_server_keys.js";
import { MIDDLEWARE_ORDER } from "./http_server_util.js";

/* ──────────────────────────────────────────────────────────────────────────
 * §A1 路由表的形状
 * ──────────────────────────────────────────────────────────────────────── */

/** 分段方案 `tmp/w218_SEGMENTS.md` 的段号。S2 不拥有 handler（WS 内部方法），
 *  S10 拥有装配与四个内联体（`_on_cleanup_app` / `_cron_turn_handler` /
 *  `_MCPToolProvider` / `_bot_dispatch`）。 */
export type SegmentId =
  | "S0"
  | "S1"
  | "S2"
  | "S3"
  | "S4"
  | "S5"
  | "S6"
  | "S7"
  | "S8"
  | "S9"
  | "S10";

/** `web.get/post/put/patch/delete` 的方法名（源里出现的全在这五个里）。 */
export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteSpec {
  /** HTTP 方法 */
  readonly m: RouteMethod;
  /** 路径字面量，逐字照抄源（含 `{id}` / `{sessionId}` / `{name}` 参数段） */
  readonly p: string;
  /** handler 名（`HandlerName` 的成员；正文归 `seg` 那一段） */
  readonly h: HandlerName;
  /** 所属段（按**源行号**归属，不按主题——三处跨界见 NOTES §2 末尾的冲突表） */
  readonly seg: SegmentId;
  /** handler `def` 所在的源行 */
  readonly src: number;
  /** 请求体解析姿势。**穷尽枚举**：`none` / `json=await request.json()` 的四变体 /
   *  `await request.read()` 的四变体 / WebSocket 升级。源里不存在
   *  `request.text()` `request.post()` `request.url` `request.remote` multipart——
   *  谁写出这些就是越界（NOTES §1.4）。 */
  readonly parse: string;
  /** 这条 handler 需要的 seam 名。命名规则：
   *  `app:ROUTER_KEY` / `app:SESSION_HOST_KEY` = 状态读取（走 keys.ts 的 AppState）；
   *  `web.FileResponse` / `web.WebSocketResponse` / `WSMsgType` = aiohttp 面；
   *  `fs:` / `subprocess:` / `S<n>:` 前缀 = 文件 IO / 子进程 / 跨段私有 helper，
   *  后者必须先在对方段的产物里导出。其余是子系统单例名。 */
  readonly seams: readonly string[];
}

/**
 * 源 8222–8423 `app.add_routes([...])` 的 160 条注册，**逐条按源顺序**。
 * 计数（机械核对，见 `tmp/w218_S0_gen.mjs`）：160 条注册 / 155 个不同 handler
 * （`handle_skill_candidate_action` ×4、`handle_wecom_webhook` ×2、
 *  `handle_evolution_decide` ×2 ⇒ 160−3−1−1=155）。
 * 按段分组（路由条数）：S1 1 · S3 8 · S4 30 · S5 32 · S6 29 · S7 34 · S8 11 · S9 15。
 * 另有 2 条**条件注册**的静态路由（8435/8436）不在本表里，见 §A4 `STATIC_ROUTES`。
 */
export const ROUTE_TABLE: readonly RouteSpec[] = [
  { m: "GET", p: "/ws", h: "handle_websocket", seg: "S1", src: 837, parse: "upgrade=web.WebSocketResponse(heartbeat=30); async for msg in ws; WSMsgType.TEXT -> json.loads(msg.data) (except JSONDecodeError -> _send_error(\"Invalid JSON\")); WSMsgType.ERROR -> print + break", seams: ["web.WebSocketResponse", "WSMsgType", "json.loads(msg.data)", "turnState", "askUser"] },
  { m: "GET", p: "/api/health", h: "handle_health", seg: "S3", src: 2839, parse: "none", seams: ["goalScheduler", "instanceLock", "storage"] },
  { m: "GET", p: "/api/images/{image_id}", h: "handle_get_image", seg: "S3", src: 2977, parse: "none", seams: ["app:ROUTER_KEY", "imageStore", "web.FileResponse"] },
  { m: "GET", p: "/api/files", h: "handle_get_file", seg: "S3", src: 3212, parse: "none · query:path（唯一的 path 准入门，白名单语义逐字保留）", seams: ["app:ROUTER_KEY", "S3:preview_allowed_roots", "S3:resolve_local_media_path", "S3:_media_file_rate_ok", "S3:_reset_media_file_rate", "path_guard", "web.FileResponse"] },
  { m: "GET", p: "/api/goals", h: "handle_goals", seg: "S4", src: 3261, parse: "none", seams: ["goalManager", "goalScheduler"] },
  { m: "POST", p: "/api/goals", h: "handle_create_goal", seg: "S4", src: 3274, parse: "json=await request.json() BARE（handler 内无兜底：异常冒出 handler，handler 不产生任何响应。最终渲染码不能从源码推出（aiohttp 版本间异常类不同）⇒ 走装配层 seam render_uncaught，由 python 侧探针钉死；端口禁止自行编 400/500）", seams: ["goalManager", "goalScheduler"] },
  { m: "PATCH", p: "/api/goals/{id}", h: "handle_update_goal", seg: "S4", src: 3315, parse: "json=await request.json() BARE（handler 内无兜底：异常冒出 handler，handler 不产生任何响应。最终渲染码不能从源码推出（aiohttp 版本间异常类不同）⇒ 走装配层 seam render_uncaught，由 python 侧探针钉死；端口禁止自行编 400/500）", seams: ["eventBus", "goalManager", "goalScheduler"] },
  { m: "DELETE", p: "/api/goals/{id}", h: "handle_delete_goal", seg: "S4", src: 3398, parse: "none", seams: ["goalManager", "goalScheduler"] },
  { m: "POST", p: "/api/goals/{id}/run", h: "handle_run_goal", seg: "S4", src: 3418, parse: "none", seams: ["goalManager", "goalScheduler"] },
  { m: "POST", p: "/api/goals/{id}/pause", h: "handle_pause_goal", seg: "S4", src: 3442, parse: "none", seams: ["goalManager", "goalScheduler"] },
  { m: "POST", p: "/api/goals/{id}/confirm-stopped", h: "handle_confirm_goal_stopped", seg: "S3", src: 2880, parse: "none", seams: ["goalManager", "goalScheduler"] },
  { m: "GET", p: "/api/goals/{id}/iterations", h: "handle_goal_iterations", seg: "S4", src: 3470, parse: "none", seams: ["goalManager"] },
  { m: "GET", p: "/api/goals/{id}/events", h: "handle_goal_events", seg: "S4", src: 3499, parse: "none", seams: ["goalManager"] },
  { m: "GET", p: "/api/goals/{id}/contract", h: "handle_goal_contract", seg: "S4", src: 3529, parse: "none", seams: ["acceptanceContract", "storage"] },
  { m: "GET", p: "/api/reflections", h: "handle_reflections", seg: "S4", src: 3539, parse: "none", seams: ["reflectionEngine"] },
  { m: "GET", p: "/api/curriculum/gaps", h: "handle_curriculum_gaps", seg: "S4", src: 3549, parse: "none", seams: ["curriculumEngine", "storage"] },
  { m: "GET", p: "/api/skills/patterns", h: "handle_skill_patterns", seg: "S4", src: 3558, parse: "none", seams: ["skillComposer", "storage"] },
  { m: "GET", p: "/api/evolution/undo", h: "handle_evolution_undo_list", seg: "S4", src: 3594, parse: "none", seams: ["evolutionUndo"] },
  { m: "POST", p: "/api/evolution/undo", h: "handle_evolution_undo", seg: "S4", src: 3577, parse: "json=await request.json() / except Exception -> {}", seams: ["evolutionUndo"] },
  { m: "GET", p: "/api/workflows/schedules", h: "handle_workflow_schedules_list", seg: "S4", src: 3605, parse: "none", seams: ["workflowScheduler"] },
  { m: "POST", p: "/api/workflows/schedules", h: "handle_workflow_schedule_create", seg: "S4", src: 3614, parse: "json=await request.json() / except Exception -> {}", seams: ["workflowScheduler"] },
  { m: "DELETE", p: "/api/workflows/schedules/{id}", h: "handle_workflow_schedule_delete", seg: "S4", src: 3642, parse: "none", seams: ["workflowScheduler"] },
  { m: "GET", p: "/api/crons", h: "handle_crons", seg: "S4", src: 3655, parse: "none", seams: ["cronManager"] },
  { m: "POST", p: "/api/crons", h: "handle_create_cron", seg: "S4", src: 3662, parse: "json=await request.json() BARE（handler 内无兜底：异常冒出 handler，handler 不产生任何响应。最终渲染码不能从源码推出（aiohttp 版本间异常类不同）⇒ 走装配层 seam render_uncaught，由 python 侧探针钉死；端口禁止自行编 400/500）", seams: ["cronManager"] },
  { m: "PATCH", p: "/api/crons/{id}", h: "handle_update_cron", seg: "S4", src: 3698, parse: "json=await request.json() BARE（handler 内无兜底：异常冒出 handler，handler 不产生任何响应。最终渲染码不能从源码推出（aiohttp 版本间异常类不同）⇒ 走装配层 seam render_uncaught，由 python 侧探针钉死；端口禁止自行编 400/500）", seams: ["cronManager"] },
  { m: "DELETE", p: "/api/crons/{id}", h: "handle_delete_cron", seg: "S4", src: 3715, parse: "none", seams: ["cronManager"] },
  { m: "GET", p: "/api/bot/messages", h: "handle_bot_messages", seg: "S4", src: 3725, parse: "none", seams: ["botRemote"] },
  { m: "POST", p: "/api/bot/send", h: "handle_bot_send", seg: "S4", src: 3734, parse: "json=await request.json() BARE（handler 内无兜底：异常冒出 handler，handler 不产生任何响应。最终渲染码不能从源码推出（aiohttp 版本间异常类不同）⇒ 走装配层 seam render_uncaught，由 python 侧探针钉死；端口禁止自行编 400/500）", seams: ["botRemote"] },
  { m: "GET", p: "/api/bot/status", h: "handle_bot_status", seg: "S4", src: 3794, parse: "none", seams: ["botRemote"] },
  { m: "GET", p: "/api/bot/config/{platform}", h: "handle_bot_config_get", seg: "S4", src: 3749, parse: "none", seams: ["botRemote", "storage"] },
  { m: "PUT", p: "/api/bot/config/{platform}", h: "handle_bot_config_put", seg: "S4", src: 3776, parse: "json=await request.json() BARE（handler 内无兜底：异常冒出 handler，handler 不产生任何响应。最终渲染码不能从源码推出（aiohttp 版本间异常类不同）⇒ 走装配层 seam render_uncaught，由 python 侧探针钉死；端口禁止自行编 400/500）", seams: ["botRemote", "storage"] },
  { m: "POST", p: "/api/bot/webhook/feishu", h: "handle_feishu_webhook", seg: "S4", src: 3801, parse: "raw=await request.read()", seams: ["botRemote"] },
  { m: "POST", p: "/api/bot/webhook/dingtalk", h: "handle_dingtalk_webhook", seg: "S4", src: 3820, parse: "raw=await request.read()", seams: ["botRemote"] },
  { m: "GET", p: "/api/bot/webhook/wecom", h: "handle_wecom_webhook", seg: "S4", src: 3838, parse: "raw=await request.read()", seams: ["botRemote"] },
  { m: "POST", p: "/api/bot/webhook/wecom", h: "handle_wecom_webhook", seg: "S4", src: 3838, parse: "raw=await request.read()", seams: ["botRemote"] },
  { m: "GET", p: "/api/channels", h: "handle_channels_list", seg: "S7", src: 6418, parse: "none", seams: ["channelGateway"] },
  { m: "POST", p: "/api/channels", h: "handle_channel_upsert", seg: "S7", src: 6423, parse: "json=await request.json() / except JSONDecodeError -> 400 invalid JSON", seams: ["channelGateway"] },
  { m: "DELETE", p: "/api/channels/{name}", h: "handle_channel_delete", seg: "S7", src: 6439, parse: "none", seams: ["channelGateway"] },
  { m: "POST", p: "/api/channels/{name}/inbound", h: "handle_channel_inbound", seg: "S7", src: 6447, parse: "raw=await request.read()", seams: ["channelGateway", "sessionHost"] },
  { m: "GET", p: "/api/skills", h: "handle_skills", seg: "S5", src: 3866, parse: "none", seams: ["skillLoader"] },
  { m: "POST", p: "/api/skills/relock", h: "handle_skills_relock", seg: "S7", src: 6461, parse: "none", seams: ["skillIntegrity"] },
  { m: "GET", p: "/api/skills/experiences", h: "handle_skill_experiences", seg: "S5", src: 3874, parse: "none", seams: ["storage"] },
  { m: "GET", p: "/api/relations", h: "handle_relations", seg: "S5", src: 3890, parse: "none", seams: ["storage"] },
  { m: "GET", p: "/api/approvals/pending", h: "handle_approvals_pending", seg: "S5", src: 3917, parse: "none", seams: ["approvalsProjection", "storage"] },
  { m: "GET", p: "/api/mailbox/{box_id}", h: "handle_mailbox_list", seg: "S5", src: 4273, parse: "none", seams: ["mailbox", "storage"] },
  { m: "POST", p: "/api/mailbox/{box_id}/drain", h: "handle_mailbox_drain", seg: "S5", src: 4288, parse: "none", seams: ["mailbox", "storage"] },
  { m: "GET", p: "/api/skills/candidates", h: "handle_skill_candidates", seg: "S5", src: 4299, parse: "none", seams: ["storage"] },
  { m: "POST", p: "/api/skills/candidates", h: "handle_skill_candidate_create", seg: "S5", src: 4310, parse: "json=await request.json() BARE（handler 内无兜底：异常冒出 handler，handler 不产生任何响应。最终渲染码不能从源码推出（aiohttp 版本间异常类不同）⇒ 走装配层 seam render_uncaught，由 python 侧探针钉死；端口禁止自行编 400/500）", seams: ["skillLifecycle", "storage"] },
  { m: "POST", p: "/api/skills/candidates/{id}/promote", h: "handle_skill_candidate_action", seg: "S5", src: 4320, parse: "json=await request.json() / except Exception -> {}", seams: ["eventBus", "skillLifecycle", "skillLoader", "storage"] },
  { m: "POST", p: "/api/skills/candidates/{id}/approve", h: "handle_skill_candidate_action", seg: "S5", src: 4320, parse: "json=await request.json() / except Exception -> {}", seams: ["eventBus", "skillLifecycle", "skillLoader", "storage"] },
  { m: "POST", p: "/api/skills/candidates/{id}/reject", h: "handle_skill_candidate_action", seg: "S5", src: 4320, parse: "json=await request.json() / except Exception -> {}", seams: ["eventBus", "skillLifecycle", "skillLoader", "storage"] },
  { m: "POST", p: "/api/skills/candidates/{id}/rollback", h: "handle_skill_candidate_action", seg: "S5", src: 4320, parse: "json=await request.json() / except Exception -> {}", seams: ["eventBus", "skillLifecycle", "skillLoader", "storage"] },
  { m: "POST", p: "/api/skills/import", h: "handle_import_skill", seg: "S5", src: 4367, parse: "json=await request.json() BARE（handler 内无兜底：异常冒出 handler，handler 不产生任何响应。最终渲染码不能从源码推出（aiohttp 版本间异常类不同）⇒ 走装配层 seam render_uncaught，由 python 侧探针钉死；端口禁止自行编 400/500）", seams: ["skillLoader"] },
  { m: "POST", p: "/api/skills/install", h: "handle_install_skill", seg: "S5", src: 4416, parse: "json=await request.json() BARE（handler 内无兜底：异常冒出 handler，handler 不产生任何响应。最终渲染码不能从源码推出（aiohttp 版本间异常类不同）⇒ 走装配层 seam render_uncaught，由 python 侧探针钉死；端口禁止自行编 400/500）", seams: ["skillLoader", "skillRegistry"] },
  { m: "POST", p: "/api/skills/vet", h: "handle_vet_skill", seg: "S5", src: 4457, parse: "json=await request.json() BARE（handler 内无兜底：异常冒出 handler，handler 不产生任何响应。最终渲染码不能从源码推出（aiohttp 版本间异常类不同）⇒ 走装配层 seam render_uncaught，由 python 侧探针钉死；端口禁止自行编 400/500）", seams: ["skillVetter"] },
  { m: "GET", p: "/api/skills/marketplace", h: "handle_marketplace_catalog", seg: "S5", src: 4382, parse: "none", seams: ["skillRegistry"] },
  { m: "POST", p: "/api/skills/{name}/enable", h: "handle_enable_skill", seg: "S5", src: 4497, parse: "none", seams: ["skillLoader"] },
  { m: "POST", p: "/api/skills/{name}/disable", h: "handle_disable_skill", seg: "S5", src: 4507, parse: "none", seams: ["skillLoader"] },
  { m: "POST", p: "/api/skills/{name}/uninstall", h: "handle_uninstall_skill", seg: "S5", src: 4392, parse: "none", seams: ["skillLoader"] },
  { m: "GET", p: "/api/skills/{name}", h: "handle_skill_detail", seg: "S5", src: 4404, parse: "none", seams: ["skillLoader"] },
  { m: "GET", p: "/api/plugins", h: "handle_plugins", seg: "S5", src: 4519, parse: "none", seams: ["pluginRegistry"] },
  { m: "POST", p: "/api/plugins/import", h: "handle_import_plugin", seg: "S5", src: 4528, parse: "json=await request.json() / except JSONDecodeError -> 400 invalid JSON", seams: ["pluginRegistry"] },
  { m: "POST", p: "/api/plugins/{name}/enable", h: "handle_plugin_enable", seg: "S5", src: 4544, parse: "none", seams: ["pluginRegistry"] },
  { m: "POST", p: "/api/plugins/{name}/disable", h: "handle_plugin_disable", seg: "S5", src: 4552, parse: "none", seams: ["pluginRegistry"] },
  { m: "DELETE", p: "/api/plugins/{name}", h: "handle_plugin_remove", seg: "S5", src: 4560, parse: "none", seams: ["pluginRegistry"] },
  { m: "GET", p: "/api/settings", h: "handle_get_settings", seg: "S6", src: 4612, parse: "none", seams: ["SERVER_STATE._CONFIG"] },
  { m: "PUT", p: "/api/settings", h: "handle_update_settings", seg: "S6", src: 4760, parse: "json=await request.json() / except JSONDecodeError -> 400 invalid JSON", seams: ["SERVER_STATE._CONFIG", "app:ROUTER_KEY", "app:SESSION_HOST_KEY", "contextCompactor", "gitTrust", "goalManager", "llmClient", "memoryLayer", "modelRegistry", "riskControl", "shadowConfig", "telemetry"] },
  { m: "GET", p: "/api/permissions/rules", h: "handle_permission_rules_list", seg: "S6", src: 4620, parse: "none", seams: ["permissionRules", "sandbox", "toolPolicy"] },
  { m: "POST", p: "/api/permissions/rules", h: "handle_permission_rule_create", seg: "S6", src: 4652, parse: "json=await request.json() / except Exception -> {}", seams: ["permissionRules"] },
  { m: "DELETE", p: "/api/permissions/rules/{rule_id}", h: "handle_permission_rule_delete", seg: "S6", src: 4682, parse: "none", seams: ["permissionRules"] },
  { m: "GET", p: "/api/permissions/network", h: "handle_network_policy_get", seg: "S7", src: 6537, parse: "none", seams: ["commandClassifier"] },
  { m: "GET", p: "/api/permissions/overview", h: "handle_permissions_overview", seg: "S7", src: 6548, parse: "none", seams: ["SERVER_STATE._CONFIG", "app:ROUTER_KEY", "commandClassifier", "pathPolicy", "permissionRules"] },
  { m: "GET", p: "/api/network/outbound", h: "handle_outbound_settings_get", seg: "S7", src: 6493, parse: "none", seams: ["webOutbound"] },
  { m: "PUT", p: "/api/network/outbound", h: "handle_outbound_settings_put", seg: "S7", src: 6506, parse: "json=await request.json() / except Exception -> {}", seams: ["webOutbound"] },
  { m: "PUT", p: "/api/permissions/network", h: "handle_network_policy_put", seg: "S7", src: 6618, parse: "json=await request.json() / except JSONDecodeError -> 400 invalid JSON", seams: ["SERVER_STATE._CONFIG", "commandClassifier"] },
  { m: "GET", p: "/api/models", h: "handle_models_list", seg: "S6", src: 4688, parse: "none", seams: ["modelRegistry"] },
  { m: "GET", p: "/api/models/resolve", h: "handle_models_resolve", seg: "S6", src: 4699, parse: "none", seams: ["modelRegistry"] },
  { m: "POST", p: "/api/models/providers", h: "handle_models_sync_providers", seg: "S6", src: 4714, parse: "json=await request.json() / except JSONDecodeError -> 400 invalid JSON", seams: ["modelRegistry"] },
  { m: "GET", p: "/api/tools", h: "handle_get_tools", seg: "S6", src: 4948, parse: "none", seams: ["riskControl", "toolRegistry"] },
  { m: "GET", p: "/api/tools/contracts", h: "handle_tool_contracts", seg: "S3", src: 2959, parse: "none", seams: ["toolRegistry"] },
  { m: "GET", p: "/api/browser/tabs", h: "handle_browser_tabs", seg: "S9", src: 7941, parse: "none", seams: ["browserSessions"] },
  { m: "POST", p: "/api/browser/claim", h: "handle_browser_claim", seg: "S9", src: 7978, parse: "json=await request.json() / except Exception -> {}", seams: ["browserSessions"] },
  { m: "GET", p: "/api/subagents", h: "handle_subagents_list", seg: "S6", src: 4980, parse: "none", seams: ["storage", "subagentRuntime"] },
  { m: "GET", p: "/api/subagents/types", h: "handle_subagent_types", seg: "S6", src: 5090, parse: "none", seams: ["subagentRegistry"] },
  { m: "PATCH", p: "/api/subagents/types/{name}", h: "handle_subagent_type_update", seg: "S6", src: 5101, parse: "json=await request.json() / except Exception -> {}", seams: ["modelRegistry", "storage", "subagentRegistry", "yaml", "fs:tempfile+os.replace"] },
  { m: "POST", p: "/api/subagents/kill-all", h: "handle_subagents_kill_all", seg: "S6", src: 5060, parse: "json=await request.json() / except Exception -> {}", seams: ["subagentRuntime"] },
  { m: "POST", p: "/api/subagents/{id}/kill", h: "handle_subagent_kill", seg: "S6", src: 5036, parse: "none", seams: ["subagentRuntime"] },
  { m: "GET", p: "/api/rollback", h: "handle_rollback_list", seg: "S6", src: 5224, parse: "none", seams: ["app:ROUTER_KEY", "snapshotStore"] },
  { m: "POST", p: "/api/rollback", h: "handle_rollback_apply", seg: "S6", src: 5238, parse: "json=await request.json() / except Exception -> {}", seams: ["app:ROUTER_KEY", "snapshotStore"] },
  { m: "GET", p: "/api/checkpoints", h: "handle_checkpoints", seg: "S6", src: 5262, parse: "none", seams: ["app:ROUTER_KEY", "snapshotStore", "storage"] },
  { m: "GET", p: "/api/checkpoints/preview", h: "handle_checkpoint_preview", seg: "S6", src: 5299, parse: "none", seams: ["app:ROUTER_KEY", "snapshotStore"] },
  { m: "POST", p: "/api/checkpoints/label", h: "handle_checkpoint_label", seg: "S6", src: 5314, parse: "json=await request.json() / except Exception -> {}", seams: ["app:ROUTER_KEY", "snapshotStore"] },
  { m: "GET", p: "/api/events/{sessionId}", h: "handle_get_events", seg: "S6", src: 5332, parse: "none", seams: ["storage"] },
  { m: "GET", p: "/api/events/{sessionId}/verify", h: "handle_verify_event_chain", seg: "S6", src: 5348, parse: "none", seams: ["storage"] },
  { m: "GET", p: "/api/events/{sessionId}/state", h: "handle_get_projected_state", seg: "S6", src: 5358, parse: "none", seams: ["storage"] },
  { m: "POST", p: "/api/sessions/fork_at_seq", h: "handle_fork_at_seq", seg: "S6", src: 5370, parse: "json=await request.json() / except Exception -> {}", seams: ["storage"] },
  { m: "GET", p: "/api/sessions/search", h: "handle_search_sessions", seg: "S5", src: 4444, parse: "none", seams: ["storage"] },
  { m: "GET", p: "/api/sessions/{sessionId}/log", h: "handle_get_session_log", seg: "S6", src: 5393, parse: "none", seams: ["storage"] },
  { m: "GET", p: "/api/sessions/{sessionId}/transcript", h: "handle_get_session_transcript", seg: "S6", src: 5403, parse: "none", seams: ["storage"] },
  { m: "GET", p: "/api/sessions/{sessionId}/log_info", h: "handle_get_session_log_info", seg: "S6", src: 5413, parse: "none", seams: ["storage"] },
  { m: "GET", p: "/api/artifacts", h: "handle_artifacts", seg: "S6", src: 5430, parse: "none", seams: ["app:ROUTER_KEY", "artifactIndex"] },
  { m: "GET", p: "/api/usage/stats", h: "handle_usage_stats", seg: "S6", src: 5455, parse: "none", seams: ["app:ROUTER_KEY"] },
  { m: "GET", p: "/api/token-analytics", h: "handle_token_analytics", seg: "S6", src: 5481, parse: "none", seams: ["tokenAnalytics"] },
  { m: "GET", p: "/api/memory/diagnostics", h: "handle_memory_diagnostics", seg: "S7", src: 5548, parse: "none", seams: ["app:ROUTER_KEY", "memoryLayer"] },
  { m: "POST", p: "/api/memory/reindex", h: "handle_memory_reindex", seg: "S7", src: 5621, parse: "none", seams: ["app:ROUTER_KEY"] },
  { m: "POST", p: "/api/memory/backfill", h: "handle_memory_backfill", seg: "S7", src: 5598, parse: "none", seams: ["app:ROUTER_KEY", "memoryLayer"] },
  { m: "POST", p: "/api/memory/cache/clear", h: "handle_memory_cache_clear", seg: "S7", src: 5636, parse: "none", seams: ["memoryLayer"] },
  { m: "GET", p: "/api/memory/entries", h: "handle_memory_entries", seg: "S7", src: 5883, parse: "none", seams: ["memoryLayer"] },
  { m: "GET", p: "/api/memory/entries/{id}/trace", h: "handle_memory_entry_trace", seg: "S7", src: 5682, parse: "none", seams: ["memoryDomain"] },
  { m: "GET", p: "/api/memory/conflicts", h: "handle_memory_conflicts", seg: "S7", src: 6194, parse: "none", seams: ["memoryDomain"] },
  { m: "GET", p: "/api/memory/dream-runs", h: "handle_memory_dream_runs", seg: "S7", src: 6157, parse: "none", seams: ["storage"] },
  { m: "GET", p: "/api/memory/graph", h: "handle_memory_graph", seg: "S7", src: 5700, parse: "none", seams: ["app:ROUTER_KEY"] },
  { m: "POST", p: "/api/memory/graph/triplets", h: "handle_memory_graph_triplet_create", seg: "S7", src: 5757, parse: "json=await request.json() 在**整函数 try** 内 / except Exception -> 500 {ok:false,error:str(exc)}（B14：坏 body 与 float(confidence) 的 ValueError 都落成 500）", seams: ["app:ROUTER_KEY", "memoryLayer"] },
  { m: "GET", p: "/api/memory/budget", h: "handle_memory_budget", seg: "S7", src: 5786, parse: "none", seams: ["app:ROUTER_KEY", "memoryLayer"] },
  { m: "POST", p: "/api/memory/prune", h: "handle_memory_prune", seg: "S7", src: 5808, parse: "json=if request.can_read_body else {}", seams: ["app:ROUTER_KEY", "memoryLayer"] },
  { m: "GET", p: "/api/memory/roots", h: "handle_memory_roots", seg: "S7", src: 5825, parse: "none", seams: ["app:ROUTER_KEY", "memoryLayer"] },
  { m: "POST", p: "/api/memory/entries", h: "handle_memory_entry_create", seg: "S7", src: 5917, parse: "json=await request.json() / except JSONDecodeError -> 400 invalid JSON", seams: ["app:ROUTER_KEY", "memoryLayer", "memoryTiers"] },
  { m: "PATCH", p: "/api/memory/entries/{id}", h: "handle_memory_entry_update", seg: "S7", src: 5969, parse: "json=await request.json() / except JSONDecodeError -> 400 invalid JSON", seams: ["memoryDomain", "memoryLayer"] },
  { m: "DELETE", p: "/api/memory/entries/{id}", h: "handle_memory_entry_delete", seg: "S7", src: 6060, parse: "none", seams: ["memoryLayer"] },
  { m: "GET", p: "/api/wiki/claims", h: "handle_wiki_claims", seg: "S7", src: 6071, parse: "none", seams: ["memoryLayer"] },
  { m: "POST", p: "/api/wiki/resolve", h: "handle_wiki_resolve", seg: "S7", src: 6098, parse: "json=await request.json() / except JSONDecodeError -> 400 invalid JSON", seams: ["memoryDomain", "memoryLayer"] },
  { m: "DELETE", p: "/api/wiki/claims/{id}", h: "handle_wiki_delete", seg: "S7", src: 6135, parse: "none", seams: ["memoryDomain"] },
  { m: "GET", p: "/api/git/status", h: "handle_git_status", seg: "S8", src: 7121, parse: "none", seams: ["S8:_git_router->sessionHost", "app:ROUTER_KEY", "subprocess:gitProc"] },
  { m: "GET", p: "/api/git/diff", h: "handle_git_diff", seg: "S8", src: 7190, parse: "none", seams: ["S8:_git_router->sessionHost", "app:ROUTER_KEY", "subprocess:gitProc"] },
  { m: "GET", p: "/api/git/branches", h: "handle_git_branches", seg: "S8", src: 7277, parse: "none", seams: ["S8:_git_router->sessionHost", "app:ROUTER_KEY", "subprocess:gitProc"] },
  { m: "GET", p: "/api/git/log", h: "handle_git_log", seg: "S8", src: 7421, parse: "none", seams: ["S8:_git_router->sessionHost", "app:ROUTER_KEY", "subprocess:gitProc"] },
  { m: "POST", p: "/api/git/restore", h: "handle_git_restore", seg: "S8", src: 7296, parse: "json=await request.json() / except Exception -> {}", seams: ["S8:_git_router->sessionHost", "app:ROUTER_KEY", "subprocess:gitProc"] },
  { m: "POST", p: "/api/git/checkout", h: "handle_git_checkout", seg: "S8", src: 7338, parse: "json=await request.json() / except Exception -> {}", seams: ["S8:_git_router->sessionHost", "app:ROUTER_KEY", "subprocess:gitProc"] },
  { m: "POST", p: "/api/git/branch", h: "handle_git_create_branch", seg: "S8", src: 7374, parse: "json=await request.json() / except Exception -> {}", seams: ["S8:_git_router->sessionHost", "app:ROUTER_KEY", "subprocess:gitProc"] },
  { m: "GET", p: "/api/git/commit-message", h: "handle_git_commit_message", seg: "S9", src: 7549, parse: "none · query:unstaged,model", seams: ["S8:_git_router->sessionHost", "S9:_llm_callback_for", "modelRegistry", "gitTrust"] },
  { m: "POST", p: "/api/git/commit", h: "handle_git_commit", seg: "S9", src: 7583, parse: "json=await request.json() / except Exception -> {}", seams: ["S8:_git_router->sessionHost", "app:ROUTER_KEY", "subprocess:gitProc", "S8:_resolve_git_repo", "gitTrust", "S8:_parse_porcelain"] },
  { m: "POST", p: "/api/git/push", h: "handle_git_push", seg: "S9", src: 7687, parse: "none", seams: ["S8:_git_router->sessionHost", "app:ROUTER_KEY", "subprocess:gitProc", "S8:_resolve_git_repo"] },
  { m: "GET", p: "/api/shadow/{sessionId}/status", h: "handle_shadow_status", seg: "S8", src: 6980, parse: "none", seams: ["app:ROUTER_KEY", "shadowSession"] },
  { m: "POST", p: "/api/shadow/{sessionId}/validate", h: "handle_shadow_validate", seg: "S8", src: 6996, parse: "json=if request.can_read_body else {}", seams: ["app:ROUTER_KEY", "shadowSession", "shadowWorkspace"] },
  { m: "POST", p: "/api/shadow/{sessionId}/apply", h: "handle_shadow_apply", seg: "S8", src: 7016, parse: "json=if request.can_read_body else {}", seams: ["app:ROUTER_KEY", "shadowSession", "shadowWorkspace"] },
  { m: "POST", p: "/api/shadow/{sessionId}/discard", h: "handle_shadow_discard", seg: "S8", src: 7044, parse: "none", seams: ["shadowSession"] },
  { m: "GET", p: "/api/hooks", h: "handle_get_hooks", seg: "S9", src: 7713, parse: "none", seams: ["hookRunner"] },
  { m: "POST", p: "/api/hooks/reload", h: "handle_reload_hooks", seg: "S9", src: 7741, parse: "none", seams: ["hookRunner"] },
  { m: "GET", p: "/api/mcp/servers", h: "handle_mcp_list", seg: "S7", src: 6251, parse: "none", seams: ["mcpManager", "skillRegistry"] },
  { m: "POST", p: "/api/mcp/servers", h: "handle_mcp_upsert", seg: "S7", src: 6277, parse: "json=await request.json() / except JSONDecodeError -> 400 invalid JSON", seams: ["SERVER_STATE._CONFIG", "mcpManager", "modelRegistry", "toolRegistry"] },
  { m: "DELETE", p: "/api/mcp/servers/{name}", h: "handle_mcp_delete", seg: "S7", src: 6362, parse: "none", seams: ["SERVER_STATE._CONFIG", "mcpManager"] },
  { m: "POST", p: "/api/mcp/servers/{name}/toggle", h: "handle_mcp_toggle", seg: "S7", src: 6378, parse: "json=await request.json() / except JSONDecodeError -> 400 invalid JSON", seams: ["SERVER_STATE._CONFIG", "mcpManager"] },
  { m: "POST", p: "/api/mcp/servers/{name}/restart", h: "handle_mcp_restart", seg: "S7", src: 6401, parse: "none", seams: ["mcpManager"] },
  { m: "GET", p: "/api/evolution/proposals", h: "handle_evolution_list", seg: "S9", src: 7771, parse: "none", seams: ["evolution"] },
  { m: "GET", p: "/api/evolution/proposals/all", h: "handle_evolution_list_all", seg: "S9", src: 7785, parse: "none", seams: ["evolution"] },
  { m: "GET", p: "/api/evolution/observations", h: "handle_evolution_observations", seg: "S9", src: 7805, parse: "none", seams: ["evolution"] },
  { m: "GET", p: "/api/evolution/bundles", h: "handle_learning_bundles", seg: "S3", src: 2937, parse: "none", seams: ["evolution"] },
  { m: "POST", p: "/api/evolution/proposals/{id}/accept", h: "handle_evolution_decide", seg: "S9", src: 7828, parse: "json=await request.json() / except Exception -> {}", seams: ["evolution"] },
  { m: "POST", p: "/api/evolution/proposals/{id}/reject", h: "handle_evolution_decide", seg: "S9", src: 7828, parse: "json=await request.json() / except Exception -> {}", seams: ["evolution"] },
  { m: "POST", p: "/api/evolution/mine", h: "handle_evolution_mine", seg: "S9", src: 7854, parse: "none", seams: ["evolution"] },
  { m: "GET", p: "/api/evolution/mode", h: "handle_evolution_get_mode", seg: "S9", src: 7862, parse: "none", seams: ["evolution"] },
  { m: "PUT", p: "/api/evolution/mode", h: "handle_evolution_set_mode", seg: "S9", src: 7874, parse: "json=await request.json() / except JSONDecodeError -> 400 invalid JSON", seams: ["SERVER_STATE._CONFIG", "evolution"] },
  { m: "GET", p: "/api/sessions/{id}/learning", h: "handle_session_learning", seg: "S5", src: 3932, parse: "none", seams: ["memoryDomain", "skillLoader", "storage"] },
  { m: "POST", p: "/api/learning-items/{id}/{action}", h: "handle_learning_item_action", seg: "S5", src: 4005, parse: "json=await request.json() / except Exception -> {}", seams: ["learningService", "storage"] },
  { m: "GET", p: "/api/learning-items/{id}/trace", h: "handle_learning_item_trace", seg: "S5", src: 4102, parse: "none", seams: ["scopeGuard", "storage"] },
  { m: "GET", p: "/api/episodes", h: "handle_episodes_list", seg: "S5", src: 4190, parse: "none", seams: ["storage"] },
  { m: "POST", p: "/api/episodes/seal", h: "handle_episode_seal", seg: "S5", src: 4203, parse: "json=await request.json() / except Exception -> {}", seams: ["episodeManager", "scopeGuard", "storage"] },
  { m: "GET", p: "/api/history/trace", h: "handle_history_trace", seg: "S5", src: 4242, parse: "none", seams: ["eventTypes", "storage"] },
  { m: "GET", p: "/api/system/migrations", h: "handle_migrations_status", seg: "S3", src: 2903, parse: "none", seams: ["storage"] },
  { m: "POST", p: "/api/system/migrations/retry", h: "handle_migrations_retry", seg: "S3", src: 2917, parse: "json=await request.json() / except Exception -> {}", seams: ["storage"] },
];

/* ──────────────────────────────────────────────────────────────────────────
 * §A2 handler 名联合 + 注册表契约（S10 的编译期闸门）
 * ──────────────────────────────────────────────────────────────────────── */

/** 源里被 `add_routes` 引用的 155 个 handler 名（`def` 行号见 ROUTE_TABLE.src）。 */
export type HandlerName =
  "handle_approvals_pending"
  | "handle_artifacts"
  | "handle_bot_config_get"
  | "handle_bot_config_put"
  | "handle_bot_messages"
  | "handle_bot_send"
  | "handle_bot_status"
  | "handle_browser_claim"
  | "handle_browser_tabs"
  | "handle_channel_delete"
  | "handle_channel_inbound"
  | "handle_channel_upsert"
  | "handle_channels_list"
  | "handle_checkpoint_label"
  | "handle_checkpoint_preview"
  | "handle_checkpoints"
  | "handle_confirm_goal_stopped"
  | "handle_create_cron"
  | "handle_create_goal"
  | "handle_crons"
  | "handle_curriculum_gaps"
  | "handle_delete_cron"
  | "handle_delete_goal"
  | "handle_dingtalk_webhook"
  | "handle_disable_skill"
  | "handle_enable_skill"
  | "handle_episode_seal"
  | "handle_episodes_list"
  | "handle_evolution_decide"
  | "handle_evolution_get_mode"
  | "handle_evolution_list"
  | "handle_evolution_list_all"
  | "handle_evolution_mine"
  | "handle_evolution_observations"
  | "handle_evolution_set_mode"
  | "handle_evolution_undo"
  | "handle_evolution_undo_list"
  | "handle_feishu_webhook"
  | "handle_fork_at_seq"
  | "handle_get_events"
  | "handle_get_file"
  | "handle_get_hooks"
  | "handle_get_image"
  | "handle_get_projected_state"
  | "handle_get_session_log"
  | "handle_get_session_log_info"
  | "handle_get_session_transcript"
  | "handle_get_settings"
  | "handle_get_tools"
  | "handle_git_branches"
  | "handle_git_checkout"
  | "handle_git_commit"
  | "handle_git_commit_message"
  | "handle_git_create_branch"
  | "handle_git_diff"
  | "handle_git_log"
  | "handle_git_push"
  | "handle_git_restore"
  | "handle_git_status"
  | "handle_goal_contract"
  | "handle_goal_events"
  | "handle_goal_iterations"
  | "handle_goals"
  | "handle_health"
  | "handle_history_trace"
  | "handle_import_plugin"
  | "handle_import_skill"
  | "handle_install_skill"
  | "handle_learning_bundles"
  | "handle_learning_item_action"
  | "handle_learning_item_trace"
  | "handle_mailbox_drain"
  | "handle_mailbox_list"
  | "handle_marketplace_catalog"
  | "handle_mcp_delete"
  | "handle_mcp_list"
  | "handle_mcp_restart"
  | "handle_mcp_toggle"
  | "handle_mcp_upsert"
  | "handle_memory_backfill"
  | "handle_memory_budget"
  | "handle_memory_cache_clear"
  | "handle_memory_conflicts"
  | "handle_memory_diagnostics"
  | "handle_memory_dream_runs"
  | "handle_memory_entries"
  | "handle_memory_entry_create"
  | "handle_memory_entry_delete"
  | "handle_memory_entry_trace"
  | "handle_memory_entry_update"
  | "handle_memory_graph"
  | "handle_memory_graph_triplet_create"
  | "handle_memory_prune"
  | "handle_memory_reindex"
  | "handle_memory_roots"
  | "handle_migrations_retry"
  | "handle_migrations_status"
  | "handle_models_list"
  | "handle_models_resolve"
  | "handle_models_sync_providers"
  | "handle_network_policy_get"
  | "handle_network_policy_put"
  | "handle_outbound_settings_get"
  | "handle_outbound_settings_put"
  | "handle_pause_goal"
  | "handle_permission_rule_create"
  | "handle_permission_rule_delete"
  | "handle_permission_rules_list"
  | "handle_permissions_overview"
  | "handle_plugin_disable"
  | "handle_plugin_enable"
  | "handle_plugin_remove"
  | "handle_plugins"
  | "handle_reflections"
  | "handle_relations"
  | "handle_reload_hooks"
  | "handle_rollback_apply"
  | "handle_rollback_list"
  | "handle_run_goal"
  | "handle_search_sessions"
  | "handle_session_learning"
  | "handle_shadow_apply"
  | "handle_shadow_discard"
  | "handle_shadow_status"
  | "handle_shadow_validate"
  | "handle_skill_candidate_action"
  | "handle_skill_candidate_create"
  | "handle_skill_candidates"
  | "handle_skill_detail"
  | "handle_skill_experiences"
  | "handle_skill_patterns"
  | "handle_skills"
  | "handle_skills_relock"
  | "handle_subagent_kill"
  | "handle_subagent_type_update"
  | "handle_subagent_types"
  | "handle_subagents_kill_all"
  | "handle_subagents_list"
  | "handle_token_analytics"
  | "handle_tool_contracts"
  | "handle_uninstall_skill"
  | "handle_update_cron"
  | "handle_update_goal"
  | "handle_update_settings"
  | "handle_usage_stats"
  | "handle_verify_event_chain"
  | "handle_vet_skill"
  | "handle_websocket"
  | "handle_wecom_webhook"
  | "handle_wiki_claims"
  | "handle_wiki_delete"
  | "handle_wiki_resolve"
  | "handle_workflow_schedule_create"
  | "handle_workflow_schedule_delete"
  | "handle_workflow_schedules_list";

/**
 * S10 装配时**必须**逐名提供；缺一个就编译不过。这就是"S0 只给骨架、
 * 但 S1–S10 谁也不会被静默漏掉"的机制。`HttpHandler` 的成员面见 keys.ts §WebRequest。
 */
export type HandlerRegistry = Record<HandlerName, HttpHandler>;

/* ──────────────────────────────────────────────────────────────────────────
 * §A3 纯查询工具（无 I/O；探针与 S10 的自检共用）
 * ──────────────────────────────────────────────────────────────────────── */

/** 某段拥有的路由（保持源注册顺序）。 */
export function routes_for_segment(seg: SegmentId): readonly RouteSpec[] {
  return ROUTE_TABLE.filter((r) => r.seg === seg);
}

/** 某段拥有的 handler 名（去重，排序）。 */
export function handlers_for_segment(seg: SegmentId): readonly HandlerName[] {
  const seen = new Set<HandlerName>();
  for (const r of ROUTE_TABLE) if (r.seg === seg) seen.add(r.h);
  return [...seen].sort();
}

/** 同一 handler 被多条路由复用的那几处（源里 3 个，共 8 条注册）。 */
export function shared_handlers(): ReadonlyMap<HandlerName, readonly RouteSpec[]> {
  const byHandler = new Map<HandlerName, RouteSpec[]>();
  for (const r of ROUTE_TABLE) {
    const list = byHandler.get(r.h);
    if (list) list.push(r);
    else byHandler.set(r.h, [r]);
  }
  const out = new Map<HandlerName, readonly RouteSpec[]>();
  for (const [k, v] of byHandler) if (v.length > 1) out.set(k, v);
  return out;
}

/** 全表统计（机械可核对的那三个数）。 */
export function route_table_stats(): { routes: number; handlers: number; by_seg: Record<string, number> } {
  const by_seg: Record<string, number> = {};
  const handlers = new Set<HandlerName>();
  for (const r of ROUTE_TABLE) {
    by_seg[r.seg] = (by_seg[r.seg] ?? 0) + 1;
    handlers.add(r.h);
  }
  return { routes: ROUTE_TABLE.length, handlers: handlers.size, by_seg };
}

/**
 * 需要 `app` 状态的路由（31 处读写里落在 handler 侧的 29 处；两处写在 8184/8185）。
 * S10 接线漏一个 handler 就会在运行时 `PyKeyError`（= 源的 `KeyError: 'router'` 面）。
 */
export function routes_needing_app_state(): readonly RouteSpec[] {
  return ROUTE_TABLE.filter(
    (r) => r.seams.indexOf("app:ROUTER_KEY") >= 0 || r.seams.indexOf("app:SESSION_HOST_KEY") >= 0,
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * §A4 两条条件注册的静态路由（源 8432–8436）
 * ──────────────────────────────────────────────────────────────────────────
 * 触发条件是两个 `os.path.exists`，`dist_dir` 由 `__file__` 上溯两级 = `app/ui/dist`。
 * 端口的 seam 必须收 `name` 字段（B12）但**不产生第二套路径匹配**。 */

export interface StaticRouteSpec {
  readonly src: number;
  readonly m: RouteMethod;
  readonly p: string;
  readonly target: string;
  readonly name: string | null;
  readonly requires_exists: readonly string[];
  readonly note: string;
}

export const STATIC_ROUTES: readonly StaticRouteSpec[] = [
  {
    src: 8435,
    m: "GET",
    p: "/",
    target: "dist/index.html",
    name: null,
    requires_exists: ["dist_dir", "dist_dir/index.html"],
    note: "源用 `lambda r: web.FileResponse(os.path.join(dist_dir, 'index.html'))` 注册：handler 是闭包里的 lambda，dist_dir 在被调用时才 join。端口保持同一惰性（不是提前算好的常量）。",
  },
  {
    src: 8436,
    m: "GET",
    p: "/assets/",
    target: "dist/assets",
    name: "assets",
    requires_exists: ["dist_dir", "dist_dir/index.html"],
    note: "add_static 的前缀匹配 + `name=`（aiohttp 里只用于反查 URL）。B12：seam 收 name，但端口不得因此长出第二套路径匹配。",
  },
];

/** 两条静态路由的注册条件（8432–8433 的 print 也在这一臂里：8434）。 */
export const STATIC_GATE_PRINT_SRC = 8434;

/* ──────────────────────────────────────────────────────────────────────────
 * §A5 注册顺序陷阱（8222–8423 的**数据**，不是注释；aiohttp 先注册先匹配）
 * ──────────────────────────────────────────────────────────────────────── */

export interface OrderTrap {
  readonly literal_src: number;
  readonly literal_path: string;
  readonly shadowed_src: number;
  readonly shadowed_path: string;
  readonly note: string;
}

export const REGISTER_ORDER_TRAPS: readonly OrderTrap[] = [
  {
    literal_src: 8244,
    literal_path: "/api/skills/patterns",
    shadowed_src: 8293,
    shadowed_path: "/api/skills/{name}",
    note: "顺序反了就会把 'patterns' 当成技能名。",
  },
  {
    literal_src: 8273,
    literal_path: "/api/skills/relock",
    shadowed_src: 8293,
    shadowed_path: "/api/skills/{name}",
    note: "同族：8274 experiences / 8280 candidates / 8286 import / 8287 install / 8288 vet / 8289 marketplace 全部必须先于 8293。",
  },
  {
    literal_src: 8326,
    literal_path: "/api/subagents/types",
    shadowed_src: 8329,
    shadowed_path: "/api/subagents/{id}/kill",
    note: "8327 `/api/subagents/types/{name}` 在源里只有 4 空格缩进（其余 8 空格）：list 字面量里无意义，端口保持**数据等价**，不还原缩进。",
  },
  {
    literal_src: 8341,
    literal_path: "/api/sessions/fork_at_seq",
    shadowed_src: 8344,
    shadowed_path: "/api/sessions/{sessionId}/log",
    note: "同族 8342 /api/sessions/search。",
  },
  {
    literal_src: 8359,
    literal_path: "/api/memory/entries/{id}/trace",
    shadowed_src: 8372,
    shadowed_path: "/api/memory/entries/{id}",
    note: "参数段数不同，但都在 PATCH/GET 的同前缀族里；保持源顺序，不做'等价'重排。",
  },
  {
    literal_src: 8235,
    literal_path: "/api/goals/{id}/run",
    shadowed_src: 8233,
    shadowed_path: "/api/goals/{id}",
    note: "8233/8234 是 PATCH/DELETE，8235–8240 是 POST/GET 的子路径：方法不同故互不遮蔽，但注册顺序照抄。",
  },
  {
    literal_src: 8305,
    literal_path: "/api/permissions/rules",
    shadowed_src: 8307,
    shadowed_path: "/api/permissions/rules/{rule_id}",
    note: "同族 8309 network / 8310 overview / 8314 PUT network。",
  },
  {
    literal_src: 8407,
    literal_path: "/api/evolution/proposals/{id}/accept",
    shadowed_src: 8408,
    shadowed_path: "/api/evolution/proposals/{id}/reject",
    note: "两条注册**同一个** `handle_evolution_decide`，handler 内部用 `request.path.endswith('/accept')` 分叉（7840，全文件唯一一处 `request.path`）。",
  },
  {
    literal_src: 8264,
    literal_path: "/api/bot/webhook/wecom (GET)",
    shadowed_src: 8265,
    shadowed_path: "/api/bot/webhook/wecom (POST)",
    note: "同路径双方法 → 同一 handler 内部按 `request.method` 分叉（B8：GET 握手返回 text/plain 且不带 status，POST 把 str(exc) 塞进 500 响应体）。",
  },
  {
    literal_src: 8282,
    literal_path: "/api/skills/candidates/{id}/{action}",
    shadowed_src: 8285,
    shadowed_path: "四条注册（promote/approve/reject/rollback）",
    note: "同一个 `handle_skill_candidate_action` 注册四次，动词从 `match_info['action']` 取（3753/3780/4325/4326/4684 是全文件 5 处 `match_info[...]` 下标写）。",
  },
];

/* ──────────────────────────────────────────────────────────────────────────
 * §B fail-open 臂的**逐字 print 文本**（源 8131–8606 / 8609–8796）
 * ──────────────────────────────────────────────────────────────────────────
 * 这些臂的 except 分支除了 print 什么都没做（B11 那三条连 print 都没有），
 * 所以 print 文本 = 可观测行为。`{...}` 保持 f-string 的占位写法，S10 用
 * keys.ts 的 `py_str(值)` 渲染，`py_str` 不许换成模板字符串（float/None/
 * bool 的渲染不一样：`None`→`null`、`True`→`True`、`1.0`→`1.0`）。
 * `silent: true` = 源的 except 是 `except Exception: pass`，**一行日志都不留**。
 */

export interface BootPrint {
  readonly arm: string;
  readonly src: number;
  readonly ok: readonly string[];
  readonly fail: readonly string[];
  readonly silent: boolean;
  readonly note?: string;
}

/** `create_server`（8131–8606）的臂，按源码顺序。 */
export const CREATE_BOOT_PRINTS: readonly BootPrint[] = [
  {
    arm: "turn_state.stale_reset",
    src: 8154,
    ok: ["[turn_state] {_stale} stale running turn(s) marked as error"],
    fail: ["[turn_state] stale reset skipped: {_e}"],
    silent: false,
    note: "成功分支还套了一层 `if _stale:`（8157）——计数为 0 时**不 print**，走的是无输出臂。",
  },
  {
    arm: "evolution.wiring",
    src: 8172,
    ok: ["[evolution] mode={_evo_mode}"],
    fail: ["[evolution] wiring skipped: {_e}"],
    silent: false,
    note: "configure_from_config 与 attach_to_bus 在同一只 try 里（8174–8175）：attach 失败也会走 wiring skipped，且 mode 那行 print 不会执行。",
  },
  {
    arm: "evolution_miner.start",
    src: 8188,
    ok: ["[evolution_miner] started (interval={_miner.interval_s}s)"],
    fail: ["[evolution_miner] start skipped: {_miner_e}"],
    silent: false,
    note: "except 的绑定名是 `_miner_e` 不是 `_e`（8193）；文本里没有差别，但端口若做异常变量命名对齐要知道。",
  },
  {
    arm: "workflow_scheduler.start",
    src: 8197,
    ok: ["[workflow_scheduler] started"],
    fail: ["[workflow_scheduler] start skipped: {_sched_e}"],
    silent: false,
  },
  {
    arm: "on_cleanup._on_cleanup_app",
    src: 8205,
    ok: [],
    fail: [],
    silent: true,
    note: "B11：三条清理臂（workflow_scheduler.stop / evolution_miner.stop / await close_shared_sessions()）各自 `except Exception: pass`，宽吞且零日志。注册在 8221。",
  },
  {
    arm: "shadow_config.apply_from_config",
    src: 8425,
    ok: [],
    fail: [],
    silent: true,
    note: "`except Exception: pass`（8428–8429），零日志。注意它和 run_server 8614–8618 是**同一件事的两次调用**，装配时不要合并。",
  },
  {
    arm: "static.dist_gate",
    src: 8433,
    ok: ["Serving frontend from {dist_dir}"],
    fail: [],
    silent: false,
    note: "两个 `os.path.exists` 都过才注册（8433）；print 在注册之前（8434）。",
  },
  {
    arm: "runner.site_start",
    src: 8438,
    ok: ["Server running at http://{host}:{port}", "WebSocket endpoint: ws://{host}:{port}/ws"],
    fail: [],
    silent: false,
    note: "**没有 try**：绑端口失败就直接冒出（红线 ⇒ 这一臂只能是 seam，探针用假 runner/site）。两行 print 无条件执行。",
  },
  {
    arm: "bot.start",
    src: 8447,
    ok: ["[bot] {_plat}: {_state}"],
    fail: ["[bot] listener startup failed: {_e}"],
    silent: false,
    note: "成功分支是 `for _plat, _state in _bot_report.items()`（8450）——**每个平台一行**，字典序不保证，端口保持插入序（= dict 语义）。空 report ⇒ 零行。",
  },
  {
    arm: "goal_scheduler.start",
    src: 8460,
    ok: ["[goals] scheduler started (max 2 concurrent, $5/goal cap)"],
    fail: ["[goals] scheduler startup failed: {_e}"],
    silent: false,
    note: "成功文本里的 `$5` 是字面量，不是占位符。",
  },
  {
    arm: "cron.start",
    src: 8479,
    ok: ["[cron] scheduler started (10s tick, turns via session router)"],
    fail: ["[cron] scheduler startup failed: {_e}"],
    silent: false,
    note: "内联 `_cron_turn_handler`（8488–8506，归 S10）里还有一条运行期 print：`[cron] session resolve failed for {sid}: {exc}`（8498，被 8495–8497 的 try 兜住）。8482–8486 是**嵌套 try/except pass**：`_cron_sched_cfg` 先取 `{}`，读取链任何一步异常都保持 `{}`。8509 用 `asyncio.create_task(...)` **不 await**——调度器启动结果不影响本臂 print。",
  },
  {
    arm: "evolution_review.start",
    src: 8516,
    ok: ["[evolution] background review sweep started (15min, foreground-first)"],
    fail: ["[evolution] review startup failed: {_e}"],
    silent: false,
    note: "`if start_background_review(router):`（8518）——返回假值时**不 print**，与 except 分支是两条不同的静默路。",
  },
  {
    arm: "red_team_patrol.start",
    src: 8526,
    ok: ["[security] red team patrol started (6h, foreground-first)"],
    fail: ["[security] red team patrol startup failed: {_e}"],
    silent: false,
    note: "同样是 `if` 包裹（8528）。",
  },
  {
    arm: "browser.idle_reaper",
    src: 8534,
    ok: ["[browser] idle reaper started (auto-suspend daemon)"],
    fail: ["[browser] idle reaper startup failed: {_e}"],
    silent: false,
    note: "两个函数级 import（browser_sessions / browser_idle_reaper）都在同一只 try 里：任一 import 失败 ⇒ 整臂 skipped。",
  },
  {
    arm: "subagents.orphan_reap",
    src: 8549,
    ok: ["[subagents] reaped {len(_orphans)} orphan run(s) from a previous process ({_emitted} ledger events)"],
    fail: ["[subagents] orphan reap failed: {_e}"],
    silent: false,
    note: "`if _orphans:`（8552）——空列表不 print。f-string 被拆成两个相邻字面量（8554–8555），拼起来才是完整一行；`len()` 是**列表长度**，不是字符长度。",
  },
  {
    arm: "mcp.start_all",
    src: 8563,
    ok: ["[mcp] {_name}: {_st}", "[mcp] no servers configured", "[mcp] SDK unavailable: {_mcp.import_error}"],
    fail: ["[mcp] startup failed: {_e}"],
    silent: false,
    note: "三分支：`if _report:` 逐条 print（8569–8570）／ `elif _mcp.available:`（8598）／ `else:`（8600–8601）。内层 8574–8597 还有一只独立 try：seam 注册失败 ⇒ `[mcp] seam registration failed: {_se}`，**不会**让外臂失败。内联类 `_MCPToolProvider`（8578–8588）与 `_seam.register('tool', ..., name=f'mcp:{_name}', permissions={'network': True}, source=f'mcp:{_name}')`（8592–8595）归 S10。注：源里这些字符串是双引号，此处 note 文本为了 TS 字面量安全改写成单引号，**语义不变**。",
  },
];

/** `run_server`（8609–8796）的臂，按源码顺序。 */
export const RUN_BOOT_PRINTS: readonly BootPrint[] = [
  { arm: "shadow_config.apply_from_config", src: 8614, ok: [], fail: [], silent: true, note: "与 create_server 8425 同型；`except Exception: pass`。" },
  {
    arm: "instance_lock.acquire",
    src: 8632,
    ok: [
      "[instance] lock held at {_il['lockPath']}" + " ({_il['reason']})",
      "[instance] *** LOCK NOT HELD *** {_il.get('reason')} — 另一个后端可能正在写同一个数据库；健康检查将如实上报",
    ],
    fail: ["[instance] lock check skipped: {_e}"],
    silent: false,
    note: "第一行在源里是 f-string + 条件拼接（8643–8644）：`(_il.get('reason') or '')` 为假时**没有后半截 ` (…)`**。两行 ok 走的是 `if _il.get(\"acquired\") / else`（8642/8645）。8637–8640 是**双 import 回退**（`user_dirs` → `app.backend.user_dirs`，只兜 ImportError）。",
  },
  { arm: "risk_control.init_risk_controller", src: 8651, ok: [], fail: [], silent: false, note: "**不在 try 里**：档位取 `config.get(\"permissions\", {}).get(\"mode\", \"auto\")`（默认值语义，不是 `or`）。" },
  {
    arm: "model_registry.seed_from_config",
    src: 8664,
    ok: [],
    fail: ["[warn] model registry seed failed: {e}"],
    silent: false,
    note: "except 绑定名是 `e`（不是 `_e`）。入参 `config.get(\"model\", {})`。",
  },
  {
    arm: "rate_limiter.configure",
    src: 8669,
    ok: ["[rate_limiter] configured {configured_quotas} provider quota(s) from config"],
    fail: ["[warn] rate limiter configure failed: {e}"],
    silent: false,
    note: "成功分支也套 `if configured_quotas:`（8672）——0 或空 ⇒ 静默。",
  },
  {
    arm: "llm.wiring",
    src: 8676,
    ok: ["[llm] {_llm.model_id} via {_llm.base_url}", "[llm] scene routing: {scene['models']}"],
    fail: ["[warn] No LLM api_key configured - heuristic-only mode."],
    silent: false,
    note: "`if _llm.api_key:` 二选一（8676/8687）。真分支里先 `_wire_scene_callbacks(_llm)`（7491，**归 S9**）再把三个单例的 callback 钉上（8682–8684）——**这个顺序就是语义**：单例第一次构造时固定 callback，晚一步就永远 heuristic-only。`{scene['models']}` 渲染的是 dict ⇒ 走 py_str 的 dict 形状。",
  },
  { arm: "workspace.makedirs", src: 8692, ok: [], fail: [], silent: true, note: "`if ws_root:` 才建目录；`except Exception: pass`（8694–8695）。ws_root 默认 `\".\"`，但 `config.get(\"workspace\", {}).get(\"root\", \".\")` 返回**空串**时整臂跳过（8691）。" },
  { arm: "agents.warm", src: 8699, ok: [], fail: [], silent: false, note: "五个 getter（file/computer/app/browser/search）都以 `router.workspace` 调用；**没有 try**——任一失败直接冒（8699–8709 在臂外）。" },
  {
    arm: "capability_tools.register_tools",
    src: 8713,
    ok: [],
    fail: ["[warn] register_tools failed for {_mod.__name__}: {_e}"],
    silent: false,
    note: "四模块循环（red_team / security_audit / diagnostics / recommender），每个一只 try。`{_mod.__name__}` 是**模块名**，端口由 seam 提供字符串。" },
  {
    arm: "skill_loader.discover",
    src: 8723,
    ok: ["[skills] loaded: {', '.join(discovered['loaded'])}", "[skills] skipped {f['name']}: {f['error']}"],
    fail: [],
    silent: false,
    note: "**整臂无 try**（8724 直接调）：discover 抛错就整个 run_server 挂。第一行套 `if discovered[\"loaded\"]`，join 分隔符是 `\", \"`；第二行逐条（8727–8729）。" },
  {
    arm: "plugin_registry.discover",
    src: 8734,
    ok: ["[plugins] loaded: {', '.join(plug['loaded'])}", "[plugins] broken {b['name']}: {b['error']}"],
    fail: ["[plugins] discovery skipped: {_e}"],
    silent: false,
    note: "有 try（fail-open）。注意 broken 循环**没有** `if plug[\"broken\"]` 包裹（8739）——空列表自然零行。" },
  {
    arm: "hook_runner.init_hooks",
    src: 8747,
    ok: ["[hooks] enabled, {hook_summary['registered']} hook(s) registered", "[hooks] config problem: {problem}"],
    fail: [],
    silent: false,
    note: "无 try。第二行是 `for problem in hook_summary[\"problems\"]`（8751）——**无条件循环**，空则零行。" },
  {
    arm: "bot.providers.register",
    src: 8785,
    ok: ["[bot] {_plat} provider registered (configured)", "[bot] {_plat} provider skipped (not configured)"],
    fail: ["[bot] {_plat} provider init failed: {_e}"],
    silent: false,
    note: "逐 provider 一只 try（8786–8794）。内联 `_bot_dispatch`（8763–8781，归 S10）里 `[bot] session resolve failed for {sid}: {exc}`（8780）；它 fallback 到 `await router.handle(message, ctx)`（8781）——**不是**报错。" },
  { arm: "asyncio.run(create_server(...))", src: 8796, ok: [], fail: [], silent: false, note: "整个 run_server 的**唯一出口**；D3：端口侧必须是 seam（`asyncio_run`），不能真起事件循环。" },
];

/* ──────────────────────────────────────────────────────────────────────────
 * §C create_server 的 seam 声明（S10 接线；每一项对应源里一处外部世界）
 * ──────────────────────────────────────────────────────────────────────────
 * **故意不提供默认对象**：源里每一臂的缺省行为都是一条具体的 print（或 B11 的
 * 零日志），在 S0 写死默认等于替 S10 决定假件形状。类型面强制注入 ⇒
 * S10 少接一个臂就编译不过。
 */

/** `print(...)`：fail-open 臂的唯一可见输出，必须可记录（红线：不许真写 stdout 之外还有副作用）。 */
export type PrintSink = (text: string) => void;

/** 源 8188–8192 用到的 miner 形状（`.start()` 之后还要读 `.interval_s`）。 */
export interface MinerLike {
  start(): void;
  readonly interval_s: unknown;
}

/** 源 8563–8601 的 mcp manager 形状。 */
export interface McpLike {
  load_config(config: JsonDict): void;
  start_all(): Promise<Record<string, unknown>>;
  readonly available: unknown;
  readonly import_error: unknown;
}

/** 源 8479–8509 的 cron manager 形状；handler 的返回值进 `str(...)` 面。 */
export interface CronLike {
  register_handler(pattern: string, handler: (payload: JsonDict) => Promise<unknown>): void;
  start_scheduler(): Promise<unknown>;
}

/** 源 8641–8647 的锁报告形状（`_il.get("acquired")` / `_il["lockPath"]` / `_il.get("reason")`）。 */
export interface InstanceLockReport {
  readonly acquired: unknown;
  readonly lockPath: unknown;
  readonly reason: unknown;
}

export interface CreateServerArgs {
  /** 源形参 `router: Router`（8131）。python 注解运行时不强制。 */
  readonly router: unknown;
  /** 源默认 `"127.0.0.1"`；`run_server` 8619 传的是 config 里的任意值，源不校验。 */
  readonly host: unknown;
  /** 源默认 `8765`；但 `run_server` 8622 的兜底**不经 int()**，所以这里可能是 str（见 `run_server_port`）。 */
  readonly port: unknown;
  /** 155 个 handler 的装配表；缺一个名字编译就红。 */
  readonly registry: HandlerRegistry;
}

export interface CreateServerSeams {
  /* —— 8139–8167：硬依赖，**源里没有 try**（失败直接冒出 create_server） —— */
  /** 8139–8143 `SessionHost(system_prompt=…, default_workspace=…)` */
  session_host_ctor(a: { system_prompt: unknown; default_workspace: unknown }): unknown;
  /** 8145 `session_host._sessions[router.session_id] = router`（私有字段直写） */
  session_host_mount(host: unknown, session_id: unknown, router: unknown): void;
  /** 8146 `session_host._shared_mounted = True` */
  session_host_set_shared_mounted(host: unknown, value: boolean): void;
  /** 8150 `session_host.rotate_generation()` */
  session_host_rotate_generation(host: unknown): void;
  /** 8164 `set_session_host(session_host)`（晚绑定子系统的全局发布点） */
  set_session_host(host: unknown): void;
  /** 8167 `WebSocketHandler(session_host)`（S1 的类） */
  web_socket_handler_ctor(host: unknown): unknown;
  /** 8184–8185 的两处写（全文件唯一的写点）：走 keys.ts 的 AppState，键身份见 §0 陷阱。 */
  app_state: AppState;

  /* —— fail-open 臂（每臂一只 try；文本见 §B） —— */
  /** 8156 `get_turn_state().reset_stale()` → `_stale` */
  turn_state_reset_stale(): unknown;
  /** 8174 `evolution.configure_from_config(_CONFIG, router.workspace)` → `_evo_mode` */
  evolution_configure(config: JsonDict, workspace: unknown): unknown;
  /** 8175 `evolution.attach_to_bus(router.bus)` */
  evolution_attach_to_bus(bus: unknown): void;
  /** 8183 `web.Application(middlewares=[cors_middleware, api_auth.auth_middleware])` */
  application_ctor(middlewares: readonly HttpMiddleware[]): { readonly app: unknown; readonly state: AppState };
  /** 8183 的第二个中间件（`import api_auth`，源 24 行；实现在别的单元） */
  api_auth_middleware: HttpMiddleware;
  /** 8189–8191 `get_evolution_miner(session_host=…, workspace_root=…).start()` */
  get_evolution_miner(a: { session_host: unknown; workspace_root: unknown }): MinerLike;
  /** 8198–8200 `get_workflow_scheduler().start()` */
  get_workflow_scheduler(): { start(): void };
  /** 8221 `app.on_cleanup.append(_on_cleanup_app)` */
  on_cleanup_append(fn: (app_instance: unknown) => Promise<void>): void;
  /** 8207–8208 清理臂一：`get_workflow_scheduler().stop()`（静默） */
  cleanup_workflow_scheduler_stop(): unknown;
  /** 8212–8213 清理臂二：`get_evolution_miner().stop()`（静默；**无参**调用，与启动臂不同） */
  cleanup_evolution_miner_stop(): unknown;
  /** 8217–8218 清理臂三：`await close_shared_sessions()`（静默） */
  cleanup_close_shared_sessions(): Promise<unknown>;
  /** 8222–8423 `app.add_routes([...160 条...])`：**注册顺序 = ROUTE_TABLE 数组顺序**，不得重排。 */
  register_routes(routes: readonly RouteSpec[], registry: HandlerRegistry): void;
  /** 8425–8427 `shadow_config.apply_from_config(_CONFIG)`（静默 except） */
  shadow_config_apply(config: JsonDict): void;
  /** 8432–8433 的两次 `os.path.exists`（dist_dir 与 dist_dir/index.html） */
  path_exists(p: string): boolean;
  /** 8432 的 `os.path.dirname(__file__) + '/../../ui/dist'`：路径由 S10 决定，端口不猜安装位置。 */
  dist_dir(): string;
  /** 8435 `app.router.add_get('/', lambda r: web.FileResponse(index.html))`：惰性闭包，见 STATIC_ROUTES。 */
  add_root_index(index_html: string): void;
  /** 8436 `app.router.add_static('/assets/', …, name='assets')`：B12 —— name 要收下，但不产生第二套匹配。 */
  add_static(url_prefix: string, path: string, name: string | null): void;
  /** 8438–8439 `web.AppRunner(app)` + `await runner.setup()`（红线：不真绑） */
  app_runner_setup(app: unknown): Promise<unknown>;
  /** 8440–8441 `web.TCPSite(runner, host, port)` + `await site.start()`（红线：不真绑）。
   *  host/port 是 `unknown`：aiohttp 之外没有校验，run_server 传的就是 config 原值。 */
  tcp_site_start(runner: unknown, host: unknown, port: unknown): Promise<unknown>;
  /** 8448–8450 `await get_bot_controller().start()` → report（逐平台 print） */
  bot_controller_start(): Promise<Record<string, unknown>>;
  /** 8461–8463 `get_goal_scheduler(router, router.bus, host=session_host).start()` */
  get_goal_scheduler(router: unknown, bus: unknown, host: unknown): { start(): void };
  /** 8481 `get_cron_manager()` */
  get_cron_manager(): CronLike;
  /** 8484 读的 `_CONFIG`（= SERVER_STATE._CONFIG，S0 已在 keys.ts 落好态；这里只取快照） */
  cron_sched_config(): JsonDict;
  /** 8509 `asyncio.create_task(_cron.start_scheduler())`：**不 await**，任务浮空 */
  create_task(p: Promise<unknown>): void;
  /** 8517–8518 `start_background_review(router)`（返回值真假决定 print） */
  start_background_review(router: unknown): unknown;
  /** 8527–8528 `start_red_team_patrol(router)` */
  start_red_team_patrol(router: unknown): unknown;
  /** 8535 `get_shared_session_manager()` */
  get_shared_session_manager(): unknown;
  /** 8537–8538 `IdleReaper(mgr).start()` */
  idle_reaper_start(mgr: unknown): void;
  /** 8551 `router.storage.reap_orphan_subagent_runs()` → `_orphans`（list） */
  reap_orphan_subagent_runs(storage: unknown): readonly unknown[];
  /** 8553 `record_reaped_subagents(router.storage, _orphans)` → `_emitted` */
  record_reaped_subagents(storage: unknown, orphans: readonly unknown[]): unknown;
  /** 8564–8567 `get_mcp_manager()` / `load_config` / `await start_all()` */
  get_mcp_manager(): McpLike;
  /** 8574–8595 内层臂：`_MCPToolProvider` 注册进 capabilities seam（S10 的内联类） */
  register_mcp_providers(report: Readonly<Record<string, unknown>>): void;
  /** 8606 `await asyncio.Event().wait()`：永不 resolve 的停住点（D3）。探针注入"立刻 resolve"的假件才能跑完后续断言。 */
  wait_forever(): Promise<unknown>;
  /** 全文件 print 的去向。 */
  print: PrintSink;
  /**
   * B4 的落点：10 处**裸** `await request.json()`（3279 3332 3665 3702 3737 3781 4314 4370 4420 4475）
   * 的异常冒出 handler 之后，由谁来渲染、渲染成什么状态码。
   * **源码推不出具体状态码**（aiohttp 各版本抛的类不同：纯 `json.JSONDecodeError`，
   * 还是同时继承 `web.HTTPBadRequest`）。所以端口不自创 400/500，
   * 这一条由 `tmp/w218_full_gate.mjs` 的 python 侧探针钉死后由 S10 实现。
   */
  render_uncaught(err: unknown, request: WebRequest): WebResponse;
}

/** `create_server` 的端口签名（**实现在 S10**，S0 只声明）。 */
export type CreateServerFn = (args: CreateServerArgs, seams: CreateServerSeams) => Promise<void>;

/** 源 8184–8185：全文件仅有的两处 app 状态写入。 */
export function apply_boot_state(state: AppState, router: unknown, session_host: unknown): void {
  state.set(APP_KEYS.ROUTER_KEY, router);
  state.set(APP_KEYS.SESSION_HOST_KEY, session_host);
}

/** 8183 的中间件顺序（CORS 最外层，先答 preflight 再谈 auth）。 */
export const BOOT_MIDDLEWARE_ORDER = MIDDLEWARE_ORDER;

/* ──────────────────────────────────────────────────────────────────────────
 * §R run_server 的 seam 声明（8609–8796；**同步函数**，内部 asyncio.run）
 * ──────────────────────────────────────────────────────────────────────────
 * 顺序即语义：8611–8613 的模块全局赋值 → 8641 锁 → 8651 风险档位 →
 * 8661–8688 的 LLM/单例接线（**单例第一次构造就固定 callback**）→
 * 8696 Router → 8699–8709 五个 agent warm → 8713–8752 能力/技能/插件/hook →
 * 8757–8794 bot → 8796 asyncio.run(create_server(...))。
 */

export interface RunServerSeams {
  /** 8613 的兜底：`_config_path()`（源 4577–4583，行号归 S6，但**状态**在 keys.ts 的 SERVER_STATE） */
  config_path_fallback(): string;
  /** 8616 `shadow_config.apply_from_config(config)`（静默 except，8614–8618） */
  shadow_config_apply(config: JsonDict): void;
  /** 8620 `os.environ.get(...)`（B7：同一个变量名被写了**两遍**） */
  env_get(key: string): string | undefined;
  /** 8633 `import instance_lock` */
  instance_lock_acquire(db_dir: string): InstanceLockReport;
  /** 8637–8640 的双 import 回退得到的 `db_dir()`（只兜 ImportError） */
  db_dir(): string;
  /** 8651 `init_risk_controller(config.get("permissions",{}).get("mode","auto"))` —— **无 try** */
  init_risk_controller(mode: unknown): void;
  /** 8661 `get_llm_client(config)`；返回值要能读 `api_key` / `model_id` / `base_url` */
  get_llm_client(config: JsonDict): { readonly api_key: unknown; readonly model_id: unknown; readonly base_url: unknown };
  /** 8665–8666 `get_model_registry().seed_from_config(config.get("model", {}))` */
  seed_model_registry(model_config: unknown): void;
  /** 8670–8671 `get_rate_limiter().configure(config)` → `configured_quotas` */
  configure_rate_limiter(config: JsonDict): unknown;
  /** 8680 `_wire_scene_callbacks(_llm)`（7491–7526，**归 S9**）→ `scene["clients"]` / `scene["models"]` */
  wire_scene_callbacks(llm: unknown): { readonly clients: Record<string, { call(): unknown }>; readonly models: unknown };
  /** 8682–8684 三个单例的 callback 钉死（顺序见文件头） */
  get_memory_layer(a: { llm_callback: unknown }): void;
  get_goal_manager(a: { llm_callback: unknown }): void;
  get_commit_message_generator(a: { llm_callback: unknown }): void;
  /** 8693 `os.makedirs(ws_root, exist_ok=True)`（8694–8695 静默 except） */
  makedirs(path: unknown): void;
  /** 8696 `Router(ws_root, system_prompt=system_prompt or "")` */
  router_ctor(ws_root: unknown, system_prompt: string): unknown;
  /** 8705–8709 五个 agent 单例 warm（file/computer/app/browser/search）：**无 try** */
  warm_agents(workspace: unknown): void;
  /** 8714–8716 四模块 `register_tools()`，逐模块一只 try；`{name}` 供 `{_mod.__name__}` 渲染 */
  register_capability_tools(name: string): void;
  /** 8724 `get_skill_loader().discover()`：**无 try**（抛错就挂 boot） */
  skill_discover(): { loaded: readonly string[]; failed: ReadonlyArray<{ name: unknown; error: unknown }> };
  /** 8736 `get_plugin_registry().discover()`（8734–8742 有 try） */
  plugin_discover(): { loaded: readonly string[]; broken: ReadonlyArray<{ name: unknown; error: unknown }> };
  /** 8748 `init_hooks(router.workspace, router.session_id)`：**无 try** */
  init_hooks(workspace: unknown, session_id: unknown): { enabled: unknown; registered: unknown; problems: readonly unknown[] };
  /** 8761/8783 `get_bot_controller()` + `set_llm_callback(_bot_dispatch)`（内联体归 S10） */
  bot_controller(): { set_llm_callback(fn: (message: string, ctx?: JsonDict) => Promise<unknown>): void; add_provider(p: unknown): void };
  /** 8758 `available_providers()` */
  available_providers(): readonly string[];
  /** 8787–8788 `get_provider(_plat)` + `.is_configured()` */
  get_provider(platform: string): { is_configured(): unknown };
  /** 8796 `asyncio.run(create_server(router, host, port))`：红线 ⇒ 只能 seam */
  asyncio_run(p: Promise<unknown>): void;
  print: PrintSink;
}

/** `run_server` 的端口签名（**实现在 S10**）。 */
export type RunServerFn = (
  config: JsonDict,
  seams: RunServerSeams,
  system_prompt?: string | null,
  config_path?: string | null,
) => void;

/* 8799–8819 的 `__main__` 臂：端口建模为**独立导出**（不混进 run_server），
 * 因为它的三段文件读取（三级上溯找 app/config.json、读 system_prompt.md、
 * os.path.exists 判定）本身就是 seam，且 `run_server` 的调用方还有 main.py。 */
export interface MainEntrySeams {
  /** 8807–8809：`dirname(abspath(__file__))` → `join(_here, "..", "..")` → `join(_app_dir, "config.json")` */
  resolve_config_path(): string;
  /** 8810–8811 `open(..., encoding="utf-8")` + `json.load(f)`：**无 try** ⇒ 文件缺失就是 FileNotFoundError */
  read_json(path: string): JsonDict;
  /** 8816 `os.path.exists(_sp_path)` */
  path_exists(p: string): boolean;
  /** 8817–8818 读 `system_prompt.md` 全文 */
  read_text(path: string): string;
  run: RunServerFn;
}

/* ──────────────────────────────────────────────────────────────────────────
 * §S 两处纯 CPython 语义的端口实现（不是 handler 正文，是 run_server 8619–8622
 * 的**入参求解**；S10 调它们，就不必各自重发明 `or`/`.get` 的差别）
 * ──────────────────────────────────────────────────────────────────────── */

/* §S 的 `.get` 语义不再自造：直接用 §M 的 `py_dict_get`（镜像层单一来源）。
 * 被删掉的私有那份少两个东西，实测见 `tmp/lead_strip_diff.txt`：
 *   1. 没有 Map 分支 ⇒ config 以 `Map` 表示时键命中被当成缺键；
 *   2. `dflt` 没有 `= null` 默认 ⇒ 两参 `.get(k)` 返回 `undefined` 而不是 CPython 的 `None`。 */

/**
 * 源 8619：`config.get("server", {}).get("host", "127.0.0.1")`。
 * **注意没有 `or`**：config 里写 `"host": ""` 就真的把空串传下去。
 */
export function run_server_host(config: JsonDict): unknown {
  return py_dict_get(py_dict_get(config, "server", {}), "host", "127.0.0.1");
}

/**
 * 源 8620–8622（**B7**）：
 *   `port = int(os.environ.get("OVOLVE_SERVER_PORT") or os.environ.get("OVOLVE_SERVER_PORT") or 0)`
 *   `if port <= 0: port = config.get("server", {}).get("port", 8765)`
 * 三条事实照抄不修：
 *   1. 第二个 `or` 分支读的是**同一个变量名**（大概是 `OVOLVE_PORT` 的笔误）⇒ 永远不可能生效。
 *   2. `int()` **无 try** ⇒ env 是非数字串时 ValueError 直接把 run_server 打挂
 *      （keys.ts 的 `py_int` 抛同文案：`ValueError: invalid literal for int() with base 10: <repr 原文>`）。
 *   3. 8622 的兜底**不再 int()** ⇒ config 里写 `"port": "8765"` 会原样把 **str** 交给 TCPSite。
 *      所以返回类型是 `unknown`，不是 `number`（S10 不许在这里"顺手补一个 int"）。
 * 还有第四点（**B17**）：`.get("port", 8765)` 只在**键缺失**时用默认。
 * env 未设 ⇒ `port=0` ⇒ 进 8622；若 config 写的是 `"port": 0`，最终端口就是 **0**
 * （aiohttp 侧 `TCPSite(port=0)` 会绑一个临时端口），**不会**二次回落到 8765。
 * 端口不许"顺手 clamp 成 8765"。
 */
export function run_server_port(config: JsonDict, env_get: (key: string) => string | undefined): unknown {
  const name = "OVOLVE_SERVER_PORT";
  const first: unknown = env_get(name);
  const second: unknown = env_get(name); // B7：与 first 同名，永不生效
  const raw: unknown = py_truth(first) ? first : py_truth(second) ? second : 0;
  const port = py_int(raw); // B7：无 try
  if (port <= 0) return py_dict_get(py_dict_get(config, "server", {}), "port", 8765);
  return port;
}

/**
 * 源 8611–8613：`global _CONFIG, _CONFIG_PATH` 的两次赋值。
 * 写在这里是因为那两个模块全局（源 4573–4574）**横跨 S6/S7/S9/S10**，S0 必须给唯一一份
 * （keys.ts 的 `SERVER_STATE`），否则四段各造一个 `_CONFIG`。
 * 8613 的 `config_path or _config_path()` 是**真值**判定（空串走兜底）且**短路**
 * （`_config_path()` 要探盘，只有兜底时才调用）。
 */
export function apply_run_server_globals(
  config: JsonDict,
  config_path: string | null | undefined,
  fallback: () => string,
): void {
  SERVER_STATE._CONFIG = config;
  SERVER_STATE._CONFIG_PATH = py_truth(config_path) ? (config_path as string) : fallback();
}

// PORT STATUS: 本文件无 TODO(port)。
