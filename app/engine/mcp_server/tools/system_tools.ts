/**
 * mcp_server/tools/system_tools.ts — Read-only system introspection tools.
 *
 * Ported from `app/backend/mcp_server/tools/system_tools.py` (51 lines).
 *
 * Intentionally narrow: the gateway is a public surface, so we do NOT expose
 * shell / process kill / installers here. Only lookups that don't mutate
 * state.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: .../tools/system_tools.py -> .../tools/system_tools.ts
 *   §2  behaviour: falsy-name gate, mask-hint substring checks, ctx default
 *       0.0 and its falsy branch.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { Result } from "../../result.js";
import { get_device_fingerprint } from "../../device_fingerprint.js";

type JsonDict = Record<string, unknown>;

/** py ``v.strip()`` where v came from ``args.get(...)``: a non-str value
 *  raises AttributeError at that point; MCPServer._invoke converts it to
 *  ``AttributeError: '<type>' object has no attribute 'strip'``. */
class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "AttributeError";
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "boolean") return "bool";
    if (Array.isArray(v)) return "list";
    return "object";
}

function pyStrip(v: unknown): string {
    if (typeof v !== "string") {
        throw new AttributeErrorP(
            `'${pyTypeName(v)}' object has no attribute 'strip'`);
    }
    return v.trim();
}

/** Return a coarse platform description. */
export function platform_info(_args: JsonDict, _ctx: JsonDict): Result {
    return get_device_fingerprint().report();
}

/** Read a single non-sensitive environment variable.
 *
 *  Sensitive names (``KEY``, ``TOKEN``, ``SECRET``, ``PASSWORD``) are masked
 *  to prevent the gateway from leaking credentials via echo. */
export function env_var(args: JsonDict, _ctx: JsonDict): Result {
    // py args.get("name",""): a present-but-null name stays None and dies on
    // .strip() with AttributeError('NoneType'...) — `?? ""` would mask that.
    const name = pyStrip("name" in args ? args["name"] : "");
    if (!name) {
        return Result.failure("Missing 'name'", { code: "MissingArg" });
    }
    const value = process.env[name];
    if (value === undefined) {
        return Result.success({ name, value: null });
    }
    const upper = name.toUpperCase();
    if (["KEY", "TOKEN", "SECRET", "PASSWORD"].some((hint) => upper.includes(hint))) {
        return Result.success({ name, value: "<masked>" });
    }
    return Result.success({ name, value });
}

/** Report seconds since the app started (server-relative). */
export function uptime(_args: JsonDict, ctx: JsonDict): Result {
    const started = (ctx["server_started_at"] ?? 0.0) as number;
    if (!started) {
        return Result.failure("No server start time in ctx", { code: "NoStartTime" });
    }
    return Result.success({ seconds: Date.now() / 1000 - started });
}

export const TOOLS: Record<string, (args: JsonDict, ctx: JsonDict) => Result> = {
    platform_info,
    env_var,
    uptime,
};

// PORT STATUS: confidence=high todos=[0]
