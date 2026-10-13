/**
 * mcp_manager.ts — Manage external MCP servers, expose their tools to the agent.
 *
 * Ported from `app/backend/mcp_manager.py` (622 lines, wave-8, unit 181).
 *
 * Aligned with mainstream MCP clients:
 * - Config lives under `mcpServers` in `config.json` (industry-standard shape).
 * - A local entry: `{command, args, env, disabled}`.
 * - A remote entry: `{url, headers, type, disabled}` — `type` being one of
 *   `http` (Streamable HTTP), `sse` or `websocket`. Omit it and the
 *   transport is inferred from the URL scheme.
 * - On startup we connect each enabled server, initialize an MCP `ClientSession`
 *   over the chosen transport, `list_tools()`, and register each remote tool
 *   into the shared `ToolRegistry` under a namespaced name
 *   `mcp__<server>__<tool>`.
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import { Result } from "./result.js";
import { ToolDef, get_tool_registry, ToolRegistry } from "./tools.js";

export const DEFAULT_CALL_TIMEOUT = 60.0;
export const STARTUP_TIMEOUT = 30.0;
export const HEARTBEAT_INTERVAL = 30.0;
export const HEARTBEAT_TIMEOUT = 10.0;
export const TRANSPORTS = ["stdio", "http", "sse", "websocket"] as const;

export function pyJsonDumps(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "null";
  if (typeof val === "string") return JSON.stringify(val);
  if (Array.isArray(val)) {
    return "[" + val.map(pyJsonDumps).join(", ") + "]";
  }
  if (typeof val === "object") {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      parts.push(JSON.stringify(k) + ": " + pyJsonDumps(v));
    }
    return "{" + parts.join(", ") + "}";
  }
  return String(val);
}

export function _infer_transport(raw_type: string, url: string, command: string): string {
  const t = (raw_type || "").trim().toLowerCase();
  if (t === "streamable-http" || t === "streamablehttp" || t === "streamable_http") {
    return "http";
  }
  if (t === "ws" || t === "wss") {
    return "websocket";
  }
  if ((TRANSPORTS as readonly string[]).includes(t)) {
    return t;
  }
  if (url) {
    const u = url.toLowerCase();
    return u.startsWith("ws://") || u.startsWith("wss://") ? "websocket" : "http";
  }
  return "stdio";
}

export class MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  disabled: boolean;
  timeout: number | null;
  url: string;
  headers: Record<string, string>;
  transport: string;

  constructor(opts: {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    disabled?: boolean;
    timeout?: number | null;
    url?: string;
    headers?: Record<string, string>;
    transport?: string;
  }) {
    this.name = opts.name;
    this.command = opts.command ?? "";
    this.args = opts.args ?? [];
    this.env = opts.env ?? {};
    this.disabled = opts.disabled ?? false;
    this.timeout = opts.timeout ?? null;
    this.url = opts.url ?? "";
    this.headers = opts.headers ?? {};
    this.transport = opts.transport ?? "stdio";
  }

  get is_remote(): boolean {
    return this.transport !== "stdio";
  }

  static from_dict(name: string, d: Record<string, any>): MCPServerConfig {
    const raw_env = d["env"] || {};
    const raw_headers = d["headers"] || {};
    const url = String(d["url"] || d["serverUrl"] || "").trim();
    const command = String(d["command"] || "");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw_env)) {
      env[String(k)] = String(v);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw_headers)) {
      headers[String(k)] = String(v);
    }
    return new MCPServerConfig({
      name,
      command,
      args: ((d["args"] as any[]) || []).map((a) => String(a)),
      env,
      disabled: Boolean(d["disabled"]),
      timeout: typeof d["timeout"] === "number" ? d["timeout"] : null,
      url,
      headers,
      transport: _infer_transport(
        String(d["type"] || d["transport"] || ""),
        url,
        command
      ),
    });
  }
}

export class MCPToolInfo {
  qualified_name: string;
  raw_name: string;
  description: string;
  schema: Record<string, any>;

  constructor(qualified_name: string, raw_name: string, description: string, schema: Record<string, any>) {
    this.qualified_name = qualified_name;
    this.raw_name = raw_name;
    this.description = description;
    this.schema = schema;
  }
}

class AsyncEvent {
  private _isSet = false;
  private _waiters: Array<() => void> = [];

  is_set(): boolean {
    return this._isSet;
  }

  set(): void {
    this._isSet = true;
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w();
  }

  clear(): void {
    this._isSet = false;
  }

  async wait(): Promise<void> {
    if (this._isSet) return;
    return new Promise<void>((resolve) => {
      this._waiters.push(resolve);
    });
  }
}

async function waitFor<T>(promise: Promise<T>, timeoutSec: number, timeoutMsg?: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(timeoutMsg || `Operation timed out after ${timeoutSec}s`);
          err.name = "TimeoutError";
          reject(err);
        }, timeoutSec * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface MCPSessionLike {
  initialize?(): Promise<void>;
  list_tools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: any; input_schema?: any }> }>;
  call_tool(name: string, kwargs?: { arguments?: any }): Promise<{ content?: Array<{ text?: string; data?: any }>; isError?: boolean }>;
  send_ping?(): Promise<any>;
  close?(): Promise<void>;
}

export const MCP_MANAGER_SEAMS = {
  mcp_available: true,
  mcp_import_error: "",
  now: (): number => Date.now() / 1000,
  open_streams: async (config: MCPServerConfig): Promise<[any, any]> => {
    return [null, null];
  },
  create_session: async (read: any, write: any, config: MCPServerConfig): Promise<MCPSessionLike> => {
    throw new Error("No session factory bound");
  },
  get_tool_registry: () => get_tool_registry(),
  heartbeat_interval: HEARTBEAT_INTERVAL,
  heartbeat_timeout: HEARTBEAT_TIMEOUT,
  startup_timeout: STARTUP_TIMEOUT,
};

export function _set_seams_for_parity(patch: Partial<typeof MCP_MANAGER_SEAMS>): void {
  Object.assign(MCP_MANAGER_SEAMS, patch);
}

export function _reset_seams_for_parity(): void {
  MCP_MANAGER_SEAMS.mcp_available = true;
  MCP_MANAGER_SEAMS.mcp_import_error = "";
  MCP_MANAGER_SEAMS.now = () => Date.now() / 1000;
  MCP_MANAGER_SEAMS.open_streams = async () => [null, null];
  MCP_MANAGER_SEAMS.create_session = async () => {
    throw new Error("No session factory bound");
  };
  MCP_MANAGER_SEAMS.get_tool_registry = () => get_tool_registry();
  MCP_MANAGER_SEAMS.heartbeat_interval = HEARTBEAT_INTERVAL;
  MCP_MANAGER_SEAMS.heartbeat_timeout = HEARTBEAT_TIMEOUT;
  MCP_MANAGER_SEAMS.startup_timeout = STARTUP_TIMEOUT;
}

export class MCPServerConnection {
  config: MCPServerConfig;
  private _registry: any;
  status: string;
  error: string;
  tools: MCPToolInfo[];
  session: any;
  started_at: number;
  private _task: Promise<void> | null;
  private _stop: AsyncEvent;
  private _ready: AsyncEvent;

  constructor(config: MCPServerConfig, registry: any) {
    this.config = config;
    this._registry = registry;
    this.status = config.disabled ? "disabled" : "idle";
    this.error = "";
    this.tools = [];
    this.session = null;
    this.started_at = 0.0;
    this._task = null;
    this._stop = new AsyncEvent();
    this._ready = new AsyncEvent();
  }

  async start(): Promise<void> {
    if (this.config.disabled) {
      this.status = "disabled";
      return;
    }
    if (this.status === "connected") {
      return;
    }
    if (!MCP_MANAGER_SEAMS.mcp_available) {
      this.status = "failed";
      this.error = `mcp SDK not installed (${MCP_MANAGER_SEAMS.mcp_import_error})`;
      return;
    }
    if (this.config.is_remote) {
      if (!this.config.url) {
        this.status = "failed";
        this.error = `transport '${this.config.transport}' needs a url`;
        return;
      }
    } else if (!this.config.command) {
      this.status = "failed";
      this.error = "no command configured";
      return;
    }

    this._stop.clear();
    this._ready.clear();
    this.status = "starting";
    this.error = "";
    this._task = this._runner();
    try {
      await waitFor(this._ready.wait(), MCP_MANAGER_SEAMS.startup_timeout);
    } catch (err: any) {
      if (err?.name === "TimeoutError") {
        this.status = "failed";
        this.error = `startup exceeded ${Math.round(MCP_MANAGER_SEAMS.startup_timeout)}s`;
        await this.stop();
      }
    }
  }

  async stop(): Promise<void> {
    this._unregister_tools();
    this._stop.set();
    const task = this._task;
    this._task = null;
    if (task) {
      try {
        await waitFor(task, 5.0);
      } catch (e: any) {
        if (e?.name !== "TimeoutError") {
          console.log(`[mcp] stop(): teardown error while waiting for server task: ${e}`);
        }
      }
    }
    this.session = null;
    this.tools = [];
    if (this.status !== "failed" && this.status !== "lost") {
      this.status = this.config.disabled ? "disabled" : "idle";
    }
  }

  async _open_streams(): Promise<[any, any]> {
    return MCP_MANAGER_SEAMS.open_streams(this.config);
  }

  async _runner(): Promise<void> {
    let session: any = null;
    try {
      const [read, write] = await this._open_streams();
      session = await MCP_MANAGER_SEAMS.create_session(read, write, this.config);
      if (session && typeof session.initialize === "function") {
        await session.initialize();
      }
      this.session = session;
      await this._discover_tools(session);
      this.status = "connected";
      this.started_at = MCP_MANAGER_SEAMS.now();
      this._ready.set();
      await this._hold_until_stopped(session);
    } catch (exc: any) {
      this.status = "failed";
      const excName = exc?.name || "Exception";
      const excMsg = exc?.message || String(exc);
      this.error = `${excName}: ${excMsg}`;
    } finally {
      this.session = null;
      if (this.status === "failed" || this.status === "lost") {
        try {
          this._unregister_tools();
        } catch (e) {
          console.log(`[mcp] unregister tools after failure failed: ${e}`);
        }
      }
      this._ready.set();
      if (session && typeof session.close === "function") {
        try {
          await session.close();
        } catch {}
      }
    }
  }

  async _hold_until_stopped(session: any): Promise<void> {
    const interval = MCP_MANAGER_SEAMS.heartbeat_interval;
    if (interval <= 0) {
      await this._stop.wait();
      return;
    }
    while (!this._stop.is_set()) {
      try {
        await waitFor(this._stop.wait(), interval);
        return;
      } catch (err: any) {
        if (err?.name !== "TimeoutError") throw err;
      }
      const [alive, detail] = await this._probe(session);
      if (!alive) {
        this.status = "lost";
        this.error = detail;
        return;
      }
    }
  }

  async _probe(session: any): Promise<[boolean, string]> {
    const probe = typeof session?.send_ping === "function"
      ? () => session.send_ping()
      : (typeof session?.list_tools === "function" ? () => session.list_tools() : null);
    if (probe === null) {
      return [true, ""];
    }
    const hbTimeout = MCP_MANAGER_SEAMS.heartbeat_timeout;
    try {
      await waitFor(probe(), hbTimeout);
      return [true, ""];
    } catch (exc: any) {
      if (exc?.name === "TimeoutError") {
        return [false, `心跳超时（${hbTimeout}s 内无响应）`];
      }
      const excName = exc?.name || "Exception";
      const excMsg = exc?.message || String(exc);
      return [false, `连接已断开：${excName}: ${excMsg}`];
    }
  }

  async _discover_tools(session: any): Promise<void> {
    const resp = await session.list_tools();
    this.tools = [];
    const toolList = Array.isArray(resp?.tools) ? resp.tools : [];
    for (const tool of toolList) {
      const toolName = tool.name;
      const qname = `mcp__${this.config.name}__${toolName}`;
      const schema = tool.inputSchema ?? tool.input_schema ?? { type: "object", properties: {} };
      const desc = tool.description || `[MCP:${this.config.name}] ${toolName}`;
      const info = new MCPToolInfo(
        qname,
        toolName,
        desc,
        schema && typeof schema === "object" ? schema : { type: "object", properties: {} }
      );
      this.tools.push(info);
      this._register_tool(info);
    }
  }

  _register_tool(info: MCPToolInfo): void {
    const server_name = this.config.name;
    const timeout = this.config.timeout || DEFAULT_CALL_TIMEOUT;

    const _handler = async (args: Record<string, any>, ctx: Record<string, any>): Promise<Result> => {
      if (this.session === null) {
        return Result.failure(
          `MCP server '${server_name}' is not connected`,
          { server: server_name, tool: info.raw_name }
        );
      }
      try {
        const resp: any = await waitFor(
          this.session.call_tool(info.raw_name, { arguments: args }),
          timeout
        );
        const parts: string[] = [];
        const content = resp?.content || [];
        for (const block of content) {
          if (block?.text) {
            parts.push(block.text);
          } else if (block && "data" in block) {
            parts.push(pyJsonDumps(block.data));
          }
        }
        const output = parts.length > 0 ? parts.join("\n") : "(empty response)";
        if (resp?.isError) {
          return Result.failure(output, { server: server_name });
        }
        return Result.success(output, { server: server_name, tool: info.raw_name });
      } catch (exc: any) {
        if (exc?.name === "TimeoutError") {
          return Result.failure(
            `MCP tool '${info.raw_name}' timed out after ${timeout}s`,
            { server: server_name }
          );
        }
        const excName = exc?.name || "Exception";
        const excMsg = exc?.message || String(exc);
        return Result.failure(
          `MCP call failed: ${excName}: ${excMsg}`,
          { server: server_name, tool: info.raw_name }
        );
      }
    };

    const tool_def = new ToolDef(
      info.qualified_name,
      `[MCP:${server_name}] ${info.description}`,
      info.schema,
      _handler,
      {
        domain: "mcp",
        risk_level: "medium",
        needs_confirmation: true,
        group: `mcp:${server_name}`,
      }
    );
    const registry = MCP_MANAGER_SEAMS.get_tool_registry();
    registry.register(tool_def);
  }

  _unregister_tools(): void {
    const registry = MCP_MANAGER_SEAMS.get_tool_registry() as any;
    for (const info of this.tools) {
      if (registry._tools instanceof Map) {
        registry._tools.delete(info.qualified_name);
      } else if (registry._tools && typeof registry._tools === "object") {
        delete registry._tools[info.qualified_name];
      }
    }
  }

  snapshot(): Record<string, any> {
    const isConnected = this.status === "connected";
    const uptime = this.started_at && isConnected
      ? Math.round((MCP_MANAGER_SEAMS.now() - this.started_at) * 10) / 10
      : 0;
    return {
      name: this.config.name,
      command: this.config.command,
      args: [...this.config.args],
      transport: this.config.transport,
      url: this.config.url,
      status: this.status,
      error: this.error,
      disabled: this.config.disabled,
      toolCount: this.tools.length,
      tools: this.tools.map((t) => ({
        name: t.qualified_name,
        raw: t.raw_name,
        desc: t.description,
      })),
      uptimeSeconds: uptime,
    };
  }
}

export class MCPManager {
  private _servers: Map<string, MCPServerConnection> = new Map();

  load_config(config: Record<string, any>): void {
    const registry = MCP_MANAGER_SEAMS.get_tool_registry();
    const raw = config["mcpServers"] || config["mcp_servers"] || {};
    if (raw && typeof raw === "object") {
      for (const [name, entry] of Object.entries(raw)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const cfg = MCPServerConfig.from_dict(name, entry as Record<string, any>);
        this._servers.set(name, new MCPServerConnection(cfg, registry));
      }
    }
  }

  async start_all(): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    const coros: Array<[string, Promise<void>]> = [];
    for (const [name, conn] of this._servers.entries()) {
      if (conn.config.disabled) {
        results[name] = "disabled";
      } else {
        coros.push([name, conn.start()]);
      }
    }

    for (const [name, coro] of coros) {
      await coro;
      const conn = this._servers.get(name);
      results[name] = conn ? conn.status : "unknown";
    }
    return results;
  }

  async stop_all(): Promise<void> {
    for (const conn of this._servers.values()) {
      await conn.stop();
    }
  }

  async restart(name: string): Promise<string> {
    const conn = this._servers.get(name);
    if (!conn) {
      return "not_found";
    }
    await conn.stop();
    conn.config.disabled = false;
    await conn.start();
    return conn.status;
  }

  async disable(name: string): Promise<string> {
    const conn = this._servers.get(name);
    if (!conn) {
      return "not_found";
    }
    conn.config.disabled = true;
    await conn.stop();
    return "disabled";
  }

  async enable(name: string): Promise<string> {
    const conn = this._servers.get(name);
    if (!conn) {
      return "not_found";
    }
    conn.config.disabled = false;
    await conn.start();
    return conn.status;
  }

  list_servers(): Record<string, any>[] {
    return Array.from(this._servers.values()).map((conn) => conn.snapshot());
  }

  get_server(name: string): MCPServerConnection | undefined {
    return this._servers.get(name);
  }

  get available(): boolean {
    return MCP_MANAGER_SEAMS.mcp_available;
  }

  get import_error(): string {
    return MCP_MANAGER_SEAMS.mcp_import_error;
  }
}

let _manager: MCPManager | null = null;

export function get_mcp_manager(): MCPManager {
  if (_manager === null) {
    _manager = new MCPManager();
  }
  return _manager;
}
