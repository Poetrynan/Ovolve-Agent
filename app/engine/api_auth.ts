/**
 * api_auth.ts — local-process authentication for the HTTP / WebSocket API.
 *
 * Ported from `app/backend/api_auth.py` (198 lines, sha256_16 3c4786436213cc08).
 *
 * Why this exists (source docstring, kept as the contract): the API binds to
 * 127.0.0.1, which keeps it off the network but does NOT keep it private —
 * every other process running as this user can reach it. One secret, three
 * ways to present it (header / Bearer / query). There is deliberately no
 * "auth disabled" switch.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only — `node:crypto` (timingSafeEqual, randomBytes)
 *       replaces hmac.compare_digest / secrets.token_urlsafe; the aiohttp
 *       middleware becomes a framework-agnostic request shape + middleware
 *       hook (the engine has no aiohttp; consumers wire it into their server).
 *   §2  `except Exception: pass` swallows preserved verbatim (token-file
 *       read/write/chmod are all fail-open by design in the source).
 *   §2  module-level `_token` cache keeps the same resolution order:
 *       injected env → cached file value → freshly generated; and the
 *       import-time eager initialization is behaviour (§2 import-time side
 *       effects) — reproduced as a top-level call.
 *   §2  timing-safe comparison: timingSafeEqual requires equal-length
 *       buffers, so both sides are hashed first — this preserves the
 *       constant-time property without leaking length through an early
 *       return (Python's compare_digest already behaves this way).
 *   §4  naming: api_auth.py → api_auth.ts
 *
 * PORT STATUS: confidence=high todos=0
 *
 * PORT FIX PROVENANCE (red line 2 - this file was edited ONLY on CPython evidence,
 * produced by `python -B` against a byte-copy of the read-only source; the brief-time
 * port was sha256_16 f909bba09800c3e1 / 238 lines). D1-D4 below are the four faces where
 * the 238-line port answered differently from the interpreter that owns the semantics.
 *
 *  D1  token_file_path(): Python's `Path(__file__).resolve().parent.parent / ".api_token"`
 *      is a real, writable path; the port built it from
 *      `new URL(import.meta.url).pathname`, which on Windows is "/D:/..." and
 *      `path.resolve` turns that into "C:\\D:\\..." (measured in this chain). The import-time
 *      side effect (§2) then failed ENOENT and was swallowed by the source's own fail-open
 *      except, so the dev-proxy token file was NEVER written by the port.
 *      Evidence: tmp/apiau_oracle_module_py.json key import_with_env (file_exists=true,
 *      file_content=<the token>) versus the emitted-artifact measurement recorded in
 *      tmp/apiau_STATE.md and the case rows fp#env_written_at_import / fp#generated_written
 *      (tmp/apiau_cases.json). Fixed with
 *      `fileURLToPath`, which is the file-system path `__file__` actually names.
 *
 *  D2  str.strip() (§M whitespace set): the source calls `.strip()` on the injected
 *      environment value, on the token-file contents and on every presented token. CPython
 *      strips U+001C-U+001F and U+0085 and does NOT strip U+FEFF; V8's trim() is the other
 *      way round. A token whose padding is a CPython space is therefore a DIFFERENT secret
 *      in the port - a decision face, not a cosmetic one.
 *      Evidence: tmp/apiau_oracle_py.json keys strip_face / strip_samples /
 *      truthy.stripped_fs_only, plus tmp/apiau_oracle_module_py.json keys env_strip,
 *      env_strip_unitsep, env_strip_unicode_space, env_strip_bom, file_branch,
 *      file_branch_py_space. Fixed by importing py_strip/PY_ISSPACE from the already
 *      closed §M mirror layer (app/engine/server/http_server_keys.ts) - no private copy.
 *
 *  D3  `auth.lower().startswith("bearer ")`: V8's toLowerCase() folds 27 code points that
 *      CPython 3.13.14 leaves alone (U+1C89, U+A7CB/A7CC/A7DA/A7DC, U+10D50-U+10D65), so the
 *      bearer scheme test can accept or reject a header the source decides the other way.
 *      Evidence: tmp/apiau_oracle_module_py.json key extract_bearer (the "İearer FIXTOKEN-a"
 *      row and the non-breaking-space row) and §M's PY_LOWER_PRESERVE table. Fixed by
 *      importing py_lower.
 *
 *  D4  hmac.compare_digest() and str(candidate): CPython's compare_digest RAISES TypeError
 *      ("comparing strings with non-ASCII characters is not supported") when either operand
 *      is a non-ASCII str, and `str(candidate)` is CPython str(), whose spelling of true/false
 *      differs from JS String(). The 238-line port returned false instead of raising, and
 *      String(true) = "true" where str(True) = "True".
 *      Evidence: tmp/apiau_oracle_py.json keys compare_digest.nonascii_both /
 *      nonascii_left / nonascii_right / nbsp_vs_nbsp / nel_vs_nel and str_coerce;
 *      tmp/apiau_oracle_module_py.json keys token_matches (the "'é'" rows) and
 *      token_matches_str_coerce / token_matches_int_coerce. Fixed by the §M py_truth/py_str
 *      mirrors plus an explicit ASCII precondition that throws TypeError, which is exactly
 *      what the source does on that path (fail-closed by raising, never by accepting).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// RULEBOOK §M: CPython semantic mirrors are single-sourced in the closed mirror layer.
// No private PY_ISSPACE / py_strip / py_truth / py_lower copy may appear in this file.
import { py_lower, py_or, py_str, py_strip, py_truth } from "./server/http_server_keys.js";

/** Header the frontend sends. Mirrors `X-Bridge-Token` on the control bridge. */
export const TOKEN_HEADER = "X-Api-Token";
/** Query parameter for clients that physically cannot send headers. */
export const TOKEN_QUERY = "token";
/** Environment variable the Electron parent uses to inject the secret. */
export const TOKEN_ENV = "OVOLVE_API_TOKEN";

/**
 * Paths open to unauthenticated callers, with the reason each one has to be.
 * (EXEMPT_EXACT frozenset — object keys preserve the set semantics.)
 */
export const EXEMPT_EXACT: ReadonlySet<string> = new Set([
  // Electron polls this before the window exists, i.e. before it could attach
  // a token, and it returns nothing but liveness.
  "/api/health",
  // The SPA shell itself. The renderer has to load before it can authenticate.
  "/",
  "/index.html",
]);

/** Prefix-exempt paths (EXEMPT_PREFIXES tuple). */
export const EXEMPT_PREFIXES: readonly string[] = [
  // Built assets for the shell above.
  "/assets/",
  // Inbound webhooks from Feishu / DingTalk / WeCom — vendors' servers know
  // nothing about our token; they authenticate with their own per-platform
  // request signatures (see providers/*).
  "/api/bot/webhook/",
];

/** Whether `path` may be served without a token. */
export function is_exempt(path: string): boolean {
  if (EXEMPT_EXACT.has(path)) {
    return true;
  }
  return EXEMPT_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * Where a self-generated token is cached for the Vite dev proxy.
 *
 * `app/.api_token` — next to the backend rather than in a temp dir, because
 * the dev proxy config (app/ui/vite.config.ts) resolves it relatively and a
 * temp path would differ per platform.
 *
 * Python: `Path(__file__).resolve().parent.parent / ".api_token"` — backend/
 * → app/. Here: this file's dir (app/engine) → app/.
 * (D1: `new URL(import.meta.url).pathname` is NOT a Windows path — it yields
 * "/D:/..." and path.resolve mangles it, so the import-time token write died in
 * the source's own fail-open except. fileURLToPath is the path `__file__` names.)
 */
export function token_file_path(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", ".api_token");
}

/** CPython `str.isascii()` — hmac.compare_digest's own precondition (D4). */
function is_ascii_only(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

let _token: string | null = null;

/**
 * The process's API secret, generated once on first use.
 *
 * Resolution order: injected environment → previously cached value → freshly
 * generated. Generating is the fallback, never the preference.
 */
export function get_api_token(): string {
  if (py_truth(_token)) {
    return _token as string;
  }

  // D2: `(os.environ.get(TOKEN_ENV) or "").strip()` — CPython truthiness and CPython
  // whitespace, not JS's.
  const env_token = py_strip(py_or(process.env[TOKEN_ENV] ?? null, "") as string);
  if (env_token) {
    _token = env_token;
  } else {
    // Check if app/.api_token was already written by Electron
    try {
      const p = token_file_path();
      if (fs.existsSync(p)) {
        const file_tok = py_strip(fs.readFileSync(p, "utf-8"));
        if (file_tok) {
          _token = file_tok;
        }
      }
    } catch {
      // fail-open: 可选增强，失败不影响主流程
    }
    if (!py_truth(_token)) {
      // secrets.token_urlsafe(32): 32 random bytes, URL-safe base64.
      _token = crypto.randomBytes(32).toString("base64url");
    }
  }

  // Make it discoverable to the dev proxy. Best-effort: a packaged install
  // may sit on a read-only volume, and in that case Electron supplied the
  // token via the environment anyway, so nobody needs the file.
  try {
    const p = token_file_path();
    fs.writeFileSync(p, _token as string, "utf-8");
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      // fail-open: 可选增强，失败不影响主流程 (non-POSIX filesystems)
    }
  } catch {
    // fail-open: 可选增强，失败不影响主流程
  }
  return _token as string;
}

/**
 * Constant-time comparison against the process token.
 *
 * timingSafeEqual rather than `===`: a short-circuiting comparison leaks the
 * length of the shared prefix through timing, which is enough to recover a
 * secret one character at a time. Both sides are hashed to a fixed length so
 * timingSafeEqual's equal-length requirement doesn't itself leak length.
 *
 * Fail-closed on every path (see source docstring: no loopback fallback —
 * localhost is a network boundary, not an authorization one).
 */
export function token_matches(candidate: string | number | boolean | null | undefined): boolean {
  if (!py_truth(candidate)) {
    return false;
  }
  // D4: the source compares `str(candidate)`, and CPython str() spells true/false/None
  // the Python way — py_str is the closed mirror of it, String() is not.
  const a = py_str(candidate);
  const b = get_api_token();
  // D4: hmac.compare_digest refuses non-ASCII str operands with TypeError
  // (tmp/apiau_oracle_py.json compare_digest.*). Reproduce the raise; do not soften it
  // into a false, which would turn a 500 into a silently different decision.
  if (!is_ascii_only(a) || !is_ascii_only(b)) {
    throw new TypeError("comparing strings with non-ASCII characters is not supported");
  }
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Minimal request shape the extractor/middleware need (framework-agnostic). */
export interface AuthRequest {
  method?: string;
  /** Request path (request.path in aiohttp). */
  path: string;
  /** Lowercased header lookup; headers.get is case-insensitive in aiohttp. */
  headers: Record<string, string | undefined>;
  /** Parsed query string (request.query). */
  query: Record<string, string | undefined>;
}

/** Pull the presented token out of a request, in header-first order. */
export function extract_token(request: AuthRequest): string | null {
  // aiohttp's `request.headers` is a CIMultiDict: name lookup is case-insensitive under
  // Python's str.lower() (D3), not V8's toLowerCase().
  const get = (name: string): string | undefined => {
    const lower = py_lower(name);
    for (const [k, v] of Object.entries(request.headers ?? {})) {
      if (py_lower(k) === lower && v) return v;
    }
    return undefined;
  };
  const tok = get(TOKEN_HEADER);
  if (py_truth(tok)) {
    return py_strip(tok as string);
  }
  const auth = py_or(get("Authorization"), "") as string;
  if (py_lower(auth).startsWith("bearer ")) {
    // the source slices the RAW header (auth[7:]) and then CPython-strips it
    return py_strip(Array.from(auth).slice(7).join(""));
  }
  const q = request.query?.[TOKEN_QUERY];
  if (py_truth(q)) {
    return py_strip(q as string);
  }
  return null;
}

/** Whether this request may proceed — exemption or a valid token. */
export function request_authorized(request: AuthRequest): boolean {
  if (is_exempt(request.path)) {
    return true;
  }
  return token_matches(extract_token(request));
}

/** The 401 body the middleware returns (web.json_response equivalent). */
export interface AuthResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Reject unauthenticated remote callers before any handler runs.
 *
 * The source is an aiohttp middleware; this is the same decision function
 * shaped for the engine's server layer: call `auth_middleware(request)` and
 * on a non-null result, answer with its status/body instead of invoking the
 * handler. OPTIONS preflight always passes through (returns null).
 */
export function auth_middleware(
  request: AuthRequest
): AuthResponse | null {
  if (request.method === "OPTIONS") {
    return null;
  }
  if (request_authorized(request)) {
    return null;
  }
  return { status: 401, body: { error: "api token required" } };
}

// Eagerly initialize the token on module load so app/.api_token is always
// written to disk before any dev proxy or client tries to discover it.
// (RULEBOOK §2: import-time side effects are behaviour.)
try {
  get_api_token();
} catch {
  // except Exception: pass
}
