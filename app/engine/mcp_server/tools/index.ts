/**
 * mcp_server/tools/index.ts — Server-side MCP tool registry.
 *
 * Ported from `app/backend/mcp_server/tools/__init__.py` (46 lines).
 * RULEBOOK §4: package `__init__.py` -> `index.ts`.
 *
 * Tool implementations live one per file for domain isolation. This module
 * composes the registry — a plain dict mapping service_id -> {tool_name:
 * callable} — so `server.dispatch` can route incoming requests without
 * touching this package's internals.
 *
 * Add a new tool by writing `mcp_server/tools/<domain>_tools.ts` with a
 * module-level `TOOLS` dict, then importing it here.
 *
 * DIVERGENCE(port): CPython `dict.get(key, default)` only ever sees the dict's
 *   OWN keys, so `resolve("__proto__", "toString")`, `resolve("file",
 *   "constructor")` and friends return None. A bare `REGISTRY[service_id]` read
 *   in JS also walks the prototype chain and would hand back `Object.prototype`
 *   members (a callable `toString`, the `Object` constructor, ...), which is NOT
 *   bug-for-bug equivalent. Both lookups below therefore go through `ownGet()`,
 *   which reproduces dict semantics physically; the parity cases
 *   `hostile#__proto__.toString`, `hostile#constructor.name`,
 *   `hostile#hasOwnProperty.toString`, `hostile#file.__proto__`,
 *   `hostile#file.constructor`, `hostile#file.hasOwnProperty`,
 *   `hostile#file.toString`, `hostile#search.valueOf` pin the equivalence, and
 *   the `ts_reintroduce_proto_leak` / `ts_reintroduce_tool_proto_leak` mutants
 *   of the unit's negative control prove the cases really have teeth.
 * DIVERGENCE(port): the Python module namespace also carries the import aliases
 *   (`FILE_TOOLS`, `SYSTEM_TOOLS`, `SEARCH_TOOLS`) and the typing names
 *   (`Any`, `Callable`) plus the `from __future__ import annotations` artefact;
 *   ESM exports exactly the declared contract (`REGISTRY`, `resolve`,
 *   `list_tools`). None of those aliases is reachable through the barrel's own
 *   API, so the shared table compares the contract surface (`contract#*`) and
 *   not the raw namespace dump.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { Result } from "../../result.js";
import { TOOLS as FILE_TOOLS } from "./file_tools.js";
import { TOOLS as SYSTEM_TOOLS } from "./system_tools.js";
import { TOOLS as SEARCH_TOOLS } from "./search_tools.js";

type ToolHandler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Result;

/** `dict.get`-equivalent read: own properties only, never the prototype chain. */
function ownGet<T>(o: Record<string, T> | undefined, k: string): T | undefined {
    return o !== undefined && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

/** service_id -> {tool_name -> handler(args, ctx) -> Result} */
export const REGISTRY: Record<string, Record<string, ToolHandler>> = {
    file: FILE_TOOLS,
    system: SYSTEM_TOOLS,
    search: SEARCH_TOOLS,
};

/** Look up a tool handler by service_id + tool_name. Returns the handler or
 *  undefined when the service/tool is unknown (python: None). */
export function resolve(service_id: string, tool_name: string): ToolHandler | undefined {
    const svc = ownGet(REGISTRY, service_id);
    return svc === undefined ? undefined : ownGet(svc, tool_name);
}

/** Describe available tools for gateway discovery: `{service_id: [tool_name, ...]}`. */
export function list_tools(service_id: string | null = null): Record<string, string[]> {
    if (service_id) {
        const svc = ownGet(REGISTRY, service_id) ?? {};
        return { [service_id]: Object.keys(svc).sort() };
    }
    const out: Record<string, string[]> = {};
    for (const [sid, t] of Object.entries(REGISTRY)) {
        out[sid] = Object.keys(t).sort();
    }
    return out;
}

// PORT STATUS: confidence=high todos=[0]
