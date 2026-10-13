/**
 * mcp_oauth.ts — MCP 连接器的 OAuth2 client-credentials 令牌获取.
 *
 * Ported from `app/backend/mcp_oauth.py` (167 lines).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/mcp_oauth.py -> app/engine/mcp_oauth.ts
 *   §2  behaviour: expiry margin 60s + max(ttl,0); `expires_in or 3600`
 *       truthiness gate (an explicit 0 becomes 3600 — source semantics);
 *       float() coercion failures fall back to 3600.0; `scope` key only when
 *       the joined scope is non-empty; urlencode insertion order =
 *       grant_type, client_id, client_secret, scope; falsy gates on
 *       token_url/client_id/client_secret; HTTPError only reports the status
 *       code (never the body — source comment: token endpoints echo forms).
 *   §2  py `urlencode` (quote_plus) is re-implemented byte-exactly: keep
 *       [A-Za-z0-9._~-], space -> '+', all else UTF-8 %XX upper-hex.
 *       DIVERGENCE(port): JS URLSearchParams would keep `*()` unescaped and
 *       escape `~` differently, hence the bespoke encoder.
 *   DIVERGENCE(port): threading.Lock is a no-op — JS is single-threaded and
 *       the critical sections contain no awaits.
 *   DIVERGENCE(port): py sync -> async (urlopen vs fetch); mirrors the
 *       providers/index.ts precedent, call sites are async bot/mcp code.
 *   DIVERGENCE(port): transport-failure inner wording is the OS/network
 *       stack's text (py "[WinError ...] ..." vs V8 "fetch failed"); only
 *       the envelope `mcp[server]: token request failed: <X>` is product
 *       logic and is kept byte-exact. Same treatment as the JSONDecodeError
 *       divergence documented in mcp_server/server.ts.
 *   DIVERGENCE(port): py `resp.read().decode("utf-8")` is strict and raises
 *       UnicodeDecodeError (caught by the ValueError arm) on invalid bytes;
 *       V8 text() substitutes U+FFFD and falls into the JSON-parse arm.
 *       Only reachable when a token endpoint returns non-UTF-8 bytes; both
 *       arms surface as `token request failed:` errors, no silent success.
 *
 * 仅支持 client-credentials：authorization-code/PKCE 属于交互流，第一版不引入。
 */

import { CredentialCipher } from "./model_registry_impl.js";

type JsonDict = Record<string, unknown>;

/** 令牌提前过期余量（秒）。边界 401 比一次多余的刷新贵得多。 */
export const _TOKEN_EXPIRY_MARGIN_S = 60.0;

/** 单次令牌请求超时。令牌端点不该慢；慢了宁可本次连接失败重试。 */
export const _TOKEN_TIMEOUT_S = 15.0;

/** 令牌获取失败。message 面向审计日志，不含 secret 本体。 */
export class OAuthTokenError extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "OAuthTokenError";
    }
}

/** py module getattr miss on a non-dict parsed JSON body. */
class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "AttributeError";
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    return "dict";
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return Object.keys(v as object).length > 0;
}

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

function isPyDict(v: unknown): v is JsonDict {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** python float(x) accept/reject semantics (messages never escape the
 *  caller's except arm, so only the VALUE matters). */
function pyFloat(x: unknown): number {
    if (typeof x === "number") return x;
    if (typeof x === "boolean") return x ? 1 : 0;
    if (typeof x === "string") {
        let s = x.trim();
        if (s.includes("_")) {
            // PEP515 underscores between digits only; any other use errors.
            if (!/^([+-]?\d[\d_]*\.?\d*|\.?\d[\d_]*)([eE][+-]?\d+)?$/.test(s)
                || /__/.test(s) || /^\D*_/ .test(s) || /_\D*$/.test(s)) {
                throw new Error("could not convert string to float: " + JSON.stringify(x));
            }
            s = s.replaceAll("_", "");
        }
        if (/^[+-]?(inf|infinity)$/i.test(s)) {
            return s.startsWith("-") ? -Infinity : Infinity;
        }
        if (/^[+-]?nan$/i.test(s)) return NaN;
        if (/^[+-]?((\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?)$/.test(s)) return Number(s);
        throw new Error("could not convert string to float: " + JSON.stringify(x));
    }
    throw new Error(`float() argument must be a string or a real number, not '${pyTypeName(x)}'`);
}

/** python urllib.parse.quote_plus with the default safe='': keep
 *  [A-Za-z0-9._~-], space -> '+', everything else as UTF-8 %XX (upper hex). */
function pyQuotePlus(s: string): string {
    let out = "";
    for (const ch of s) {
        if (/[A-Za-z0-9._~\-]/.test(ch)) out += ch;
        else if (ch === " ") out += "+";
        else {
            for (const b of Buffer.from(ch, "utf8")) {
                out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
            }
        }
    }
    return out;
}

function _now(): number {
    return Date.now() / 1000;
}

/** 解析凭证值的三种写法：明文 / `env:VAR` / `enc:`|`plain:` 密文。 */
export function resolve_secret(value: unknown): string {
    const s = (pyTruth(value) ? pyStr(value) : "").trim();
    if (s === "") return "";
    if (s.startsWith("env:")) {
        const name = s.slice(4).trim();
        const v = process.env[name];
        return v === undefined ? "" : v;
    }
    if (s.startsWith("enc:") || s.startsWith("plain:")) {
        try {
            return new CredentialCipher().decrypt(s);
        } catch {
            return "";
        }
    }
    return s; // legacy 明文 —— 与 model_registry 对 legacy 值的处理一致
}

export class _CachedToken {
    readonly access_token: string;
    readonly expires_at: number;
    constructor(access_token: string, expires_at: number) {
        this.access_token = access_token;
        this.expires_at = expires_at;
    }
    live(): boolean {
        return pyTruth(this.access_token) && _now() < this.expires_at;
    }
}

/** DIVERGENCE(port): the module-level process singleton (dict + Lock) —
 *  lock is a no-op, single-threaded runtime. Exported like the py module
 *  attribute so invalidate/inspection paths stay byte-equivalent. */
export const _tokens: Map<string, _CachedToken> = new Map();

/** 丢弃某服务器缓存令牌。连接掉线/401 后由 mcp_manager 调用。 */
export function invalidate(server_name: string): void {
    _tokens.delete(server_name);
}

/** 向 token_url 发起一次 client-credentials 请求，返回 access_token。 */
export async function _fetch_token(server_name: string, auth: JsonDict): Promise<string> {
    const token_url = (pyTruth(auth["token_url"]) ? pyStr(auth["token_url"]) : "").trim();
    if (token_url === "") {
        throw new OAuthTokenError(`mcp[${server_name}]: auth.token_url is required`);
    }
    const client_id = resolve_secret(pyTruth(auth["client_id"]) ? pyStr(auth["client_id"]) : "");
    const client_secret = resolve_secret(pyTruth(auth["client_secret"]) ? pyStr(auth["client_secret"]) : "");
    if (!pyTruth(client_id) || !pyTruth(client_secret)) {
        throw new OAuthTokenError(
            `mcp[${server_name}]: auth.client_id/client_secret missing or undecryptable (enc: value with foreign key?)`);
    }
    const scopesRaw = pyTruth(auth["scopes"]) ? auth["scopes"] : [];
    let scope: string;
    if (Array.isArray(scopesRaw)) {
        const parts: string[] = [];
        for (const s of scopesRaw) {
            const t = pyStr(s);
            if (t.trim() !== "") parts.push(t);
        }
        scope = parts.join(" ");
    } else {
        scope = pyStr(scopesRaw);
    }

    const fields: [string, string][] = [
        ["grant_type", "client_credentials"],
        ["client_id", client_id],
        ["client_secret", client_secret],
    ];
    if (pyTruth(scope)) fields.push(["scope", scope]);
    const body = fields.map(([k, v]) => pyQuotePlus(k) + "=" + pyQuotePlus(v)).join("&");

    let resp: Response;
    let text: string;
    try {
        resp = await fetch(token_url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            body,
            signal: AbortSignal.timeout(_TOKEN_TIMEOUT_S * 1000),
        });
        if (resp.status >= 400) {
            // 不把响应体打进错误 —— 令牌端点的错误页可能回显提交的表单。
            throw new OAuthTokenError(
                `mcp[${server_name}]: token endpoint returned HTTP ${resp.status}`);
        }
        text = await resp.text();
    } catch (exc) {
        if (exc instanceof OAuthTokenError) throw exc;
        // py arms: HTTPError handled above via exc.code; URLError/OSError/
        // ValueError -> f"...token request failed: {exc}". JSON-decode wording
        // follows the CPython parser at the failure position; only the
        // first-token case ("Expecting value: line 1 column 1 (char 0)")
        // occurs for empty/HTML endpoints (DIVERGENCE(port): deeper syntax
        // positions use V8 wording, envelope identical).
        const name = exc instanceof Error ? exc.constructor?.name : "";
        let inner: string;
        if (name === "SyntaxError") {
            inner = "Expecting value: line 1 column 1 (char 0)";
        } else {
            inner = `<urlopen error ${exc instanceof Error ? exc.message : pyStr(exc)}>`;
        }
        throw new OAuthTokenError(`mcp[${server_name}]: token request failed: ${inner}`);
    }

    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        throw new OAuthTokenError(
            `mcp[${server_name}]: token request failed: Expecting value: line 1 column 1 (char 0)`);
    }
    if (!isPyDict(data)) {
        // py data.get on a list/scalar — uncaught AttributeError by design.
        throw new AttributeErrorP(
            `'${pyTypeName(data)}' object has no attribute 'get'`);
    }
    const token = pyTruth(data["access_token"]) ? pyStr(data["access_token"]) : "";
    if (token === "") {
        throw new OAuthTokenError(
            `mcp[${server_name}]: token endpoint returned no access_token`);
    }
    let ttl: number;
    try {
        ttl = pyFloat(pyTruth(data["expires_in"]) ? data["expires_in"] : 3600);
    } catch {
        ttl = 3600.0;
    }
    _tokens.set(server_name, new _CachedToken(
        token, _now() + Math.max(ttl, 0) - _TOKEN_EXPIRY_MARGIN_S));
    return token;
}

/** 返回应附加到该服务器请求上的 Authorization 头（可能为空 dict）。 */
export async function bearer_headers(
    server_name: string, auth: unknown,
): Promise<Record<string, string>> {
    if (!isPyDict(auth)
        || (pyTruth(auth["type"]) ? pyStr(auth["type"]) : "oauth2").toLowerCase() !== "oauth2") {
        return {};
    }
    const cached = _tokens.get(server_name);
    if (cached !== undefined && cached.live()) {
        return { "Authorization": `Bearer ${cached.access_token}` };
    }
    const token = await _fetch_token(server_name, auth);
    return { "Authorization": `Bearer ${token}` };
}

/** 给 REST/审计用的 auth 配置摘要 —— 绝不回显任何 secret 原文。 */
export function auth_config_summary(auth: unknown): JsonDict {
    if (!isPyDict(auth)) {
        return { enabled: false };
    }
    const secret = pyTruth(auth["client_secret"]) ? pyStr(auth["client_secret"]) : "";
    return {
        enabled: true,
        type: pyTruth(auth["type"]) ? pyStr(auth["type"]) : "oauth2",
        tokenUrl: pyTruth(auth["token_url"]) ? pyStr(auth["token_url"]) : "",
        clientId: pyTruth(auth["client_id"]) ? pyStr(auth["client_id"]) : "",
        secretProtected: secret.startsWith("enc:") || secret.startsWith("env:") || secret.startsWith("plain:"),
        scopes: Array.isArray(auth["scopes"])
            ? (auth["scopes"] as unknown[]).map((s) => pyStr(s))
            : [],
    };
}

// PORT STATUS: confidence=high todos=[0]
