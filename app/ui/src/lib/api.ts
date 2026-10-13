// Vite dev (port 5173) uses same-origin + proxy to avoid CORS.
// Tauri / packaged builds talk to the Python server on 8765 directly.
function isViteDevHost(): boolean {
  if (typeof window === 'undefined') return false
  const { hostname, protocol } = window.location
  return (hostname === 'localhost' || hostname === '127.0.0.1') && protocol.startsWith('http')
}

export let API_BASE = isViteDevHost() ? '' : 'http://127.0.0.1:8765'

export let WS_URL = isViteDevHost()
  ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
  : 'ws://127.0.0.1:8765/ws'

// ---------------------------------------------------------------------------
// Local API token (B1).
//
// The backend now rejects every non-exempt /api call and the /ws upgrade unless
// it carries the shared secret. How this client obtains the secret depends on
// how it is being served:
//
//   • Packaged Electron — the renderer talks to 127.0.0.1:8765 directly, so it
//     must attach the token itself. The Electron main process generated it,
//     handed it to the Python child via the environment, and exposes it to the
//     renderer over IPC (`app:getApiToken`). `initApiToken()` pulls it in once
//     at startup.
//   • Vite dev — requests go same-origin to :5173 and are proxied to :8765.
//     The dev proxy (vite.config.ts) reads the token from `app/.api_token` and
//     injects the header on the way through, so the browser holds no token and
//     `apiToken` stays empty. That is correct, not a bug: in dev the browser
//     never speaks to :8765 directly.
//
// A header is used wherever one can be (`fetch`). WebSockets, <img>, and the
// like cannot set headers, so they fall back to a `?token=` query — same secret,
// same loopback socket.
// ---------------------------------------------------------------------------
let apiToken = ''

/** Whether we hold a token to attach. False under the Vite dev proxy (by design). */
export function hasApiToken(): boolean {
  return apiToken.length > 0
}

/**
 * Fetch the token from the Electron main process once, at app startup.
 *
 * Idempotent and never throws: a browser (no `electronAPI`) or an IPC failure
 * simply leaves the token empty, which is the correct state under the dev proxy.
 * Awaiting it before the first request avoids a startup race where an early call
 * fires tokenless and gets a 401.
 */
export async function initApiToken(): Promise<void> {
  if (apiToken) return
  const api = (globalThis as any).electronAPI
  if (!api?.invoke) return
  try {
    const [t, p] = await Promise.all([
      api.invoke('app:getApiToken'),
      api.invoke('app:getBackendPort'),
    ])
    if (typeof t === 'string' && t) apiToken = t
    if (typeof p === 'number' && p > 0) {
      API_BASE = `http://127.0.0.1:${p}`
      WS_URL = `ws://127.0.0.1:${p}/ws`
    }
  } catch {
    /* dev / non-Electron: proxy injects the token instead */
  }
}

/** Merge the token header into an existing headers object (if we hold one). */
export function authHeaders(base?: HeadersInit): HeadersInit | undefined {
  if (!apiToken) return base
  return { ...(base as Record<string, string> | undefined), 'X-Api-Token': apiToken }
}

/** Append `?token=` for transports that cannot send headers (WS, <img>, SSE). */
export function withTokenQuery(url: string): string {
  if (!apiToken) return url
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(apiToken)
}

/**
 * `fetch` with the API token attached. Drop-in for bare `fetch(url, init)` at
 * every call site that talks to the backend — it only adds a header, so an init
 * that already carries `headers` / `body` / `method` is preserved untouched.
 */
export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!apiToken) await initApiToken()
  return fetch(url, { ...init, headers: authHeaders(init?.headers) })
}

/**
 * `fetch` + JSON with error messages a human can act on.
 *
 * The pattern this replaces was `const d = await r.json(); if (!r.ok) throw ...`
 * — which parses BEFORE checking the status, so any non-JSON error body blows up
 * inside the parser and the user is shown the parser's complaint instead of the
 * actual failure. aiohttp answers an unregistered route with the plain text
 * `404: Not Found`; feeding that to JSON.parse yields
 * "Unexpected non-whitespace character after JSON at position 3", which tells
 * the user nothing about the real problem (a stale backend missing the route).
 *
 * Order here is deliberate: read the body as text, decide what it is, and only
 * then decide what to throw.
 */
export async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  if (!apiToken) await initApiToken()
  let res: Response
  try {
    // Token attached here so every fetchJson/sendJson caller inherits auth for
    // free; bare-fetch sites use apiFetch (above) for the same effect.
    res = await fetch(url, { ...init, headers: authHeaders(init?.headers) })
  } catch {
    // Network-level failure: the backend isn't listening at all.
    throw new Error('无法连接后端服务（127.0.0.1:8765），请确认它已启动')
  }

  const text = await res.text()
  let parsed: any = undefined
  if (text) {
    try { parsed = JSON.parse(text) } catch { /* not JSON — handled below */ }
  }

  if (!res.ok) {
    // Prefer the server's own `{error}`; fall back to status, and call out 404
    // explicitly because it almost always means "backend older than the UI".
    if (parsed?.error) throw new Error(parsed.error)
    if (res.status === 404) throw new Error(`接口不存在（404 ${url}）——后端可能是旧版本，请重启后端`)
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`)
  }
  if (parsed === undefined) {
    throw new Error(`响应不是合法 JSON：${text.slice(0, 120) || '(空)'}`)
  }
  return parsed as T
}

/** POST/PATCH/DELETE helper — same error handling, JSON body encoding. */
export function sendJson<T = any>(url: string, method: string, body?: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
}

export function apiGet<T = any>(path: string): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  return fetchJson<T>(url)
}

export function apiPost<T = any>(path: string, body?: unknown): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  return sendJson<T>(url, 'POST', body)
}
