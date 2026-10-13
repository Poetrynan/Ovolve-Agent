/**
 * mcp_server/server.ts — MCP gateway HTTP entrypoint.
 *
 * Ported from `app/backend/mcp_server/server.py` (187 lines).
 *
 * Design follows the "unified gateway + service_id routing + Streamable HTTP"
 * pattern: one endpoint, ``?service_id=<id>`` picks the tool namespace, and
 * every request is signature-verified before dispatch.
 *
 * The handler is transport-agnostic — `handle_request` takes raw bytes plus
 * headers and returns a status/body pair, so it can be mounted on the
 * existing http_server, on Starlette/FastAPI, or driven directly from tests.
 * Only `run_standalone` touches a concrete server.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: .../mcp_server/server.py -> .../mcp_server/server.ts
 *   §2  latent-source-bug replication: the python `Result` dataclass has NO
 *       `.code` attribute, so `auth.code` (signature-failure path) and
 *       `result.code` (tool-failure path) raise
 *       ``AttributeError: 'Result' object has no attribute 'code'`` in the
 *       original — every 401 and every tool failure crashes handle_request
 *       and the stdlib handler answers with a closed socket, no response.
 *       pyGetAttr below reproduces the throw at the identical access point;
 *       callers must treat those two branches as crash sites (BUG(source),
 *       ported bug-for-bug per RULEBOOK §2).
 *   §2  `query or payload or ""` lazy chain, `params or {}` falsy gates,
 *       headers-last/query-first duplicate resolution, ensure_ascii=False
 *       JSON (JSON.stringify already emits raw non-ASCII).
 *   DIVERGENCE(port): JSONDecodeError text differs between CPython's parser
 *       and V8 ("Expecting value: line 1 column 1 (char 0)" vs
 *       "Unexpected token ..."). Code channel identical.
 *   DIVERGENCE(port): python's run_standalone blocks forever in
 *       serve_forever(); Node's event loop cannot block, so listen() returns
 *       immediately and the process stays alive via the open handle.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import * as http from "node:http";
import { Result } from "../result.js";
import { get_verifier, SignatureVerifier } from "./auth.js";
import { list_tools, resolve } from "./tools/index.js";

type JsonDict = Record<string, unknown>;

/** Header names carrying the signature envelope. */
export const H_BUSINESS = "ual-access-businessid";
export const H_TIMESTAMP = "ual-access-timestamp";
export const H_NONCE = "ual-access-nonce";
export const H_SIGNATURE = "ual-access-signature";
export const H_REQUEST_ID = "ual-access-requestid";

/* ---------------- python interop shims ------------------------------------ */

class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "AttributeError";
    }
}

class ValueErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ValueError";
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (typeof v === "object") {
        const ctor = (v as object).constructor?.name;
        if (ctor && ctor !== "Object") return ctor; // e.g. Result
        return "dict";
    }
    return "object";
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as JsonDict).length > 0;
    return true;
}

/** python `str(x)` for f-string interpolation of JSON-reachable values. */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "nan";
        if (v === Infinity) return "inf";
        if (v === -Infinity) return "-inf";
        return String(v);
    }
    if (typeof v === "string") return v;
    try { return JSON.stringify(v) ?? "None"; } catch { return String(v); }
}

/** python `x.strip()` — non-str raises AttributeError. */
function pyStrip(v: unknown): string {
    if (typeof v !== "string") {
        throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'strip'`);
    }
    return v.trim();
}

/** python `obj.name` attribute access: raises AttributeError when missing.
 *  Used to reproduce the source's `.code` reads on Result (see header). */
function pyGetAttr(obj: object, name: string): unknown {
    if (name in obj) return (obj as JsonDict)[name];
    throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute '${name}'`);
}

/** python `dict.get(key, default)` — non-dict payload raises AttributeError. */
function pyDictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
        throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
    }
    const v = (obj as JsonDict)[key];
    return v === undefined ? dflt : v;
}

/* ---------------- the gateway --------------------------------------------- */

/** Signature-verified MCP tool gateway. */
export class MCPServer {
    workspace_root: string;
    require_signature: boolean;
    started_at: number;
    private _verifier: SignatureVerifier;

    /**
     * Args:
     *   workspace_root: Root directory tool calls are confined to.
     *   require_signature: When False, signature checks are skipped. Only
     *       appropriate for loopback development — never for a listening socket.
     */
    constructor(workspace_root: string, require_signature: boolean = true) {
        this.workspace_root = workspace_root;
        this.require_signature = require_signature;
        this.started_at = Date.now() / 1000;
        this._verifier = get_verifier();
    }

    // ------------------------------------------------------------------
    // Request handling
    // ------------------------------------------------------------------

    /**
     * Verify and dispatch one gateway request.
     *
     * Returns `(http_status, response_dict)`; the response always uses the
     * envelope `{success, code, message, data}`. Throws AttributeError on the
     * two BUG(source) `.code` sites, exactly like the python original.
     */
    handle_request(body: Buffer | string, headers: JsonDict, query: JsonDict): [number, JsonDict] {
        const raw = typeof body === "string" ? body : body.toString("utf8"); // decode errors="replace" parity

        if (this.require_signature) {
            const auth = this._verifier.verify(
                raw,
                (headers[H_BUSINESS] ?? "") as string,
                (headers[H_TIMESTAMP] ?? "") as string,
                (headers[H_NONCE] ?? "") as string,
                (headers[H_SIGNATURE] ?? "") as string,
            );
            if (!auth.ok) {
                // BUG(source): auth.code — Result has no .code -> AttributeError.
                return [401, MCPServer._envelope(false, pyGetAttr(auth, "code") as string, auth.error)];
            }
        }

        let payload: unknown;
        try {
            payload = raw.trim().length ? JSON.parse(raw) : {};
        } catch (e) {
            return [400, MCPServer._envelope(false, "BadJSON", `Invalid JSON: ${(e as Error).message}`)];
        }

        // (query.get("service_id") or payload.get("service_id") or "").strip()
        // — evaluated lazily, left to right.
        const qSid = query["service_id"] ?? null;
        let sid: unknown = pyTruth(qSid) ? qSid : pyDictGet(payload, "service_id", null);
        if (!pyTruth(sid)) sid = "";
        const service_id = pyStrip(sid);

        const method = pyDictGet(payload, "method", "");

        if (method === "tools/list") {
            return [200, MCPServer._envelope(true, "OK", "", list_tools(pyTruth(service_id) ? service_id : null))];
        }

        if (method !== "tools/call") {
            return [400, MCPServer._envelope(false, "UnsupportedMethod",
                `Unsupported method: ${pyStr(pyTruth(method) ? method : "(none)")}`)];
        }

        if (!service_id) {
            return [400, MCPServer._envelope(false, "MissingServiceId", "service_id is required")];
        }

        const paramsRaw = pyDictGet(payload, "params", null);
        const params = (pyTruth(paramsRaw) ? paramsRaw : {}) as JsonDict;
        const tool_name = pyDictGet(params, "name", "") as string;
        const argsRaw = pyDictGet(params, "arguments", null);
        const args = (pyTruth(argsRaw) ? argsRaw : {}) as JsonDict;
        const handler = resolve(service_id, tool_name);
        if (handler === undefined) {
            return [404, MCPServer._envelope(false, "UnknownTool",
                `No tool '${pyStr(tool_name)}' in service '${pyStr(service_id)}'`)];
        }

        const ctx: JsonDict = {
            workspace_root: this.workspace_root,
            server_started_at: this.started_at,
            request_id: (headers[H_REQUEST_ID] ?? "") as string,
            business_id: (headers[H_BUSINESS] ?? "") as string,
        };
        const result = MCPServer._invoke(handler, args, ctx);
        if (!result.ok) {
            // BUG(source): result.code -> AttributeError, same latent bug.
            const code = pyTruth(pyGetAttr(result, "code")) ? pyGetAttr(result, "code") : "ToolFailed";
            return [200, MCPServer._envelope(false, code as string, result.error)];
        }
        return [200, MCPServer._envelope(true, "OK", "", result.value)];
    }

    /** Call a tool handler, converting any escape into a Result. */
    static _invoke(handler: (args: JsonDict, ctx: JsonDict) => unknown, args: JsonDict, ctx: JsonDict): Result {
        let out: unknown;
        try {
            out = handler(args, ctx);
        } catch (exc) {
            // f"{type(exc).__name__}: {exc}"
            const name = exc instanceof Error ? exc.name : pyTypeName(exc);
            const msg = exc instanceof Error ? exc.message : pyStr(exc);
            return Result.failure(`${name}: ${msg}`, { code: "ToolException" });
        }
        return out instanceof Result ? out : Result.success(out);
    }

    /** Build the uniform JSON response envelope. */
    static _envelope(success: boolean, code: string, message: string, data: unknown = null): JsonDict {
        return { success, code, message, data };
    }

    // ------------------------------------------------------------------
    // Standalone runner (stdlib only)
    // ------------------------------------------------------------------

    /**
     * Serve the gateway on a loopback socket.
     *
     * Binds to 127.0.0.1 by default. Binding to a non-loopback interface with
     * `require_signature=False` would expose unauthenticated file read/write
     * to the network, so that combination is refused.
     *
     * DIVERGENCE(port): python blocks in serve_forever(); Node returns with an
     * open listening handle that keeps the event loop alive (see header).
     * Exceptions escaping handle_request (the two BUG(source) sites) destroy
     * the socket without an HTTP response, matching the stdlib behaviour of
     * an uncaught do_POST error.
     */
    run_standalone(host: string = "127.0.0.1", port: number = 8765): void {
        if (!["127.0.0.1", "localhost", "::1"].includes(host) && !this.require_signature) {
            throw new ValueErrorP("Refusing to serve unauthenticated gateway on a non-loopback interface");
        }
        const server_self = this;
        const srv = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                let status: number;
                let payload: JsonDict;
                try {
                    const raw = Buffer.concat(chunks);
                    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
                    const query: JsonDict = {};
                    for (const [k, v] of parsed.searchParams) {
                        if (!(k in query)) query[k] = v; // parse_qs {k: v[0]}: first wins
                    }
                    const headers: JsonDict = {};
                    for (const [k, v] of Object.entries(req.headers)) {
                        // self.headers.items() keeps duplicates; dict comp keeps the LAST.
                        headers[k.toLowerCase()] = Array.isArray(v) ? v[v.length - 1] : (v ?? "");
                    }
                    const pair = server_self.handle_request(raw, headers, query);
                    status = pair[0];
                    payload = pair[1];
                } catch {
                    req.destroy();
                    res.destroy();
                    return; // uncaught handler error: close the socket, no response
                }
                const encoded = Buffer.from(JSON.stringify(payload), "utf8"); // ensure_ascii=False parity
                res.writeHead(status, {
                    "Content-Type": "application/json; charset=utf-8",
                    "Content-Length": String(encoded.length),
                });
                res.end(encoded);
            });
        });
        srv.listen(port, host);
    }
}

let _server: MCPServer | null = null;

/** Get (or create) the global MCPServer singleton. */
export function get_mcp_server(workspace_root: string | null = null, require_signature: boolean = true): MCPServer {
    if (_server === null) {
        _server = new MCPServer(
            workspace_root || process.cwd(), require_signature);
    }
    return _server;
}

// PORT STATUS: confidence=high todos=[0]
