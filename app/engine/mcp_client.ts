/**
 * mcp_client.ts — MCP client (unified gateway + service_id routing + signature header).
 *
 * Ported from `app/backend/mcp_client.py` (195 lines, wave-8, unit 180).
 *
 * Pattern: Agent only knows one gateway URL + service_id.
 * Gateway handles auth/audit/rate-limiting and routes to real providers.
 * Local atomic tools use stdio; cloud MCP uses Streamable HTTP.
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { Result } from "./result.js";

export type JsonDict = Record<string, unknown>;

export interface HttpPostFn {
  (url: string, body: string, headers: Record<string, string>, timeout: number): Promise<[number, string]>;
}

async function defaultHttpPost(
  urlStr: string,
  body: string,
  headers: Record<string, string>,
  timeoutSec: number
): Promise<[number, string]> {
  return new Promise<[number, string]>((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === "https:";
      const transport = isHttps ? https : http;

      const reqHeaders: Record<string, string> = { ...headers };
      if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === "content-length")) {
        reqHeaders["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
      }

      const req = transport.request(
        u,
        {
          method: "POST",
          headers: reqHeaders,
          timeout: timeoutSec * 1000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve([res.statusCode ?? 0, text]);
          });
        }
      );

      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy(new Error(`HTTP request timed out after ${timeoutSec}s`));
      });

      req.write(body, "utf8");
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

export const MCP_CLIENT_SEAMS = {
  http_post: defaultHttpPost as HttpPostFn,
  now: (): number => Math.floor(Date.now() / 1000),
  uuid4: (): string => crypto.randomUUID(),
};

export function _set_seams_for_parity(patch: Partial<typeof MCP_CLIENT_SEAMS>): void {
  Object.assign(MCP_CLIENT_SEAMS, patch);
}

export function _reset_seams_for_parity(): void {
  MCP_CLIENT_SEAMS.http_post = defaultHttpPost;
  MCP_CLIENT_SEAMS.now = () => Math.floor(Date.now() / 1000);
  MCP_CLIENT_SEAMS.uuid4 = () => crypto.randomUUID();
}

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

/**
 * MCPSignatureBuilder — build signature headers: md5(body + timestamp + accessKey + nonce).
 */
export class MCPSignatureBuilder {
  access_key: string;
  business_id: string;

  constructor(access_key = "", business_id = "ovolve") {
    this.access_key = access_key;
    this.business_id = business_id;
  }

  sign(body: string, timestamp: number | null = null, nonce: string | null = null): Record<string, string> {
    const ts = timestamp || MCP_CLIENT_SEAMS.now();
    const nc = nonce || MCP_CLIENT_SEAMS.uuid4().slice(0, 8);
    const raw = `${body}${ts}${this.access_key}${nc}`;
    const sig = crypto.createHash("md5").update(Buffer.from(raw, "utf8")).digest("hex");
    return {
      "X-Access-Businessid": this.business_id,
      "X-Access-Timestamp": String(ts),
      "X-Access-Nonce": nc,
      "X-Access-Signature": sig,
      "X-Access-Requestid": MCP_CLIENT_SEAMS.uuid4(),
    };
  }
}

/**
 * MCPServiceRegistry — service_id -> config mapping.
 */
export class MCPServiceRegistry {
  private _services: Map<string, JsonDict> = new Map();

  register(service_id: string, config: JsonDict): void {
    this._services.set(service_id, { ...config });
  }

  get(service_id: string): JsonDict | null {
    const val = this._services.get(service_id);
    return val ? { ...val } : null;
  }

  list_services(): JsonDict[] {
    const results: JsonDict[] = [];
    for (const [sid, cfg] of this._services) {
      const entry: JsonDict = { service_id: sid };
      for (const [k, v] of Object.entries(cfg)) {
        if (k !== "headers") {
          entry[k] = v;
        }
      }
      results.push(entry);
    }
    return results;
  }

  find_by_capability(query: string): string[] {
    const results: string[] = [];
    const qLower = query.toLowerCase();
    for (const [sid, cfg] of this._services) {
      let ext: unknown = cfg["ext_mcp_config"] ?? {};
      if (typeof ext === "string") {
        try {
          ext = JSON.parse(ext);
        } catch {
          ext = {};
        }
      }
      const extObj = (ext && typeof ext === "object" ? ext : {}) as JsonDict;
      const desc = `${String(extObj["description"] ?? "")} ${String(extObj["capabilities"] ?? "")} ${String(extObj["scenarios"] ?? "")}`;
      if (desc.toLowerCase().includes(qLower)) {
        results.push(sid);
      }
    }
    return results;
  }
}

/**
 * MCPClient — unified gateway + service_id routing.
 */
export class MCPClient {
  gateway_url: string;
  signature_builder: MCPSignatureBuilder;
  registry: MCPServiceRegistry;
  private _timeout: number;

  constructor(gateway_url = "", access_key = "", business_id = "ovolve") {
    this.gateway_url = gateway_url;
    this.signature_builder = new MCPSignatureBuilder(access_key, business_id);
    this.registry = new MCPServiceRegistry();
    this._timeout = 30;
  }

  configure_service(
    service_id: string,
    name: string,
    description: string,
    capabilities = "",
    scenarios = "",
    server_url: string | null = null,
    transport = "streamable",
    auth_type = "none",
    timeout = 30
  ): void {
    const url = server_url || `${this.gateway_url}/v1/mcp_proxy/streamable?service_id=${service_id}`;
    const ext = { description, capabilities, scenarios };
    this.registry.register(service_id, {
      service_name: name,
      server_url: url,
      transport_type: transport,
      auth_type,
      timeout,
      ext_mcp_config: pyJsonDumps(ext),
      is_need_proxy: true,
    });
  }

  async call_tool(service_id: string, tool_name: string, args: JsonDict): Promise<Result> {
    const svc = this.registry.get(service_id);
    if (!svc) {
      return Result.failure(`MCP service not found: ${service_id}`);
    }

    const url = String(svc["server_url"] ?? "");
    if (!url || url.startsWith("/v1/")) {
      return Result.failure(
        "MCP gateway not configured: set mcp.gateway_url (and signature_key) " +
        "in config.json, or pass server_url when configuring the service."
      );
    }

    const body = pyJsonDumps({ tool: tool_name, args });
    const headers = this.signature_builder.sign(body);
    headers["Content-Type"] = "application/json";

    let status = 0;
    let text = "";
    try {
      const timeoutVal = typeof svc["timeout"] === "number" ? (svc["timeout"] as number) : this._timeout;
      [status, text] = await MCP_CLIENT_SEAMS.http_post(url, body, headers, timeoutVal);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return Result.failure(`MCP call failed (${service_id}/${tool_name}): ${msg}`);
    }

    if (status >= 400) {
      return Result.failure(`MCP gateway returned ${status}: ${text.slice(0, 500)}`);
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 5000) };
    }
    return Result.success(data);
  }

  async list_tools(service_id: string): Promise<Result> {
    const svc = this.registry.get(service_id);
    if (!svc) {
      return Result.failure(`MCP service not found: ${service_id}`);
    }

    const url = String(svc["server_url"] ?? "");
    if (url && !url.startsWith("/v1/")) {
      const body = pyJsonDumps({ method: "tools/list" });
      const headers = this.signature_builder.sign(body);
      headers["Content-Type"] = "application/json";
      try {
        const timeoutVal = typeof svc["timeout"] === "number" ? (svc["timeout"] as number) : this._timeout;
        const [status, text] = await MCP_CLIENT_SEAMS.http_post(url, body, headers, timeoutVal);
        if (status < 400) {
          try {
            return Result.success(JSON.parse(text));
          } catch {
            // fail-open: optional enhancement
          }
        }
      } catch {
        // fall through to registry metadata
      }
    }

    const ext = svc["ext_mcp_config"] ?? "{}";
    let ext_data: JsonDict = {};
    try {
      ext_data = (typeof ext === "string" ? JSON.parse(ext) : ext) as JsonDict;
      if (!ext_data || typeof ext_data !== "object" || Array.isArray(ext_data)) {
        ext_data = {};
      }
    } catch {
      ext_data = {};
    }

    return Result.success({
      service_id,
      service_name: String(svc["service_name"] ?? ""),
      description: String(ext_data["description"] ?? ""),
      capabilities: String(ext_data["capabilities"] ?? ""),
    });
  }

  get_service_prompt(service_id: string): string {
    const svc = this.registry.get(service_id);
    if (!svc) return "";
    return String(svc["ext_mcp_config"] ?? "");
  }
}

let _mcp: MCPClient | null = null;

export function get_mcp_client(): MCPClient {
  if (_mcp === null) {
    _mcp = new MCPClient();
  }
  return _mcp;
}

export function _reset_mcp_client_for_parity(): void {
  _mcp = null;
}
