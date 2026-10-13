/**
 * mcp_server/index.ts — Local MCP gateway exposing tools to external clients.
 *
 * Ported from `app/backend/mcp_server/__init__.py` (10 lines).
 * RULEBOOK §4: package `__init__.py` -> `index.ts`.
 *
 * Provides:
 *   - `server.ts` : HTTP entrypoint (Streamable transport, service_id routing)
 *   - `auth.ts`   : md5(body+ts+key+nonce) signature verification
 *   - `tools/`    : Tool implementations grouped by domain
 *
 * PORT STATUS: confidence=high todos=[0]
 */

export { SignatureVerifier, get_verifier } from "./auth.js";

// PORT STATUS: confidence=high todos=[0]
