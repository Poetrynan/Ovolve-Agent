// src/lib/api.ts
// 渲染层 → Ovolve 后端（127.0.0.1:8765，aiohttp）的连接与鉴权基座。
//
// 令牌机制对齐 electron/apiToken.ts：Electron 主进程生成 32 字节 hex 令牌，
// 以 X-Api-Token 头发给后端，并经 IPC app:getApiToken 暴露给渲染层。
// 各通道的携带方式：
//   · fetch / WebSocket 自定义头能带 → authHeaders / ws 子协议注释说明
//   · <img> / <video> / pdfjs(fetch 字节流) 无法带自定义头 → withTokenQuery
//     追加 ?token=（同一密钥，同一回环套接字；对齐 api_auth 的 query 通道）
//   · Vite dev（同源 http）→ 代理层注入令牌，浏览器不持有，apiToken 为空
//     是正确状态而非缺陷。
// Ovolve 此前 src/ 内没有任何后端 fetch 封装（只有 LLM 直连），本模块是
// 第一块基座：/api/goals 轮询、goal_state_change WS、/api/files 端点共用。

function isViteDevHost(): boolean {
  if (typeof window === 'undefined') return false
  const { hostname, protocol } = window.location
  return (hostname === 'localhost' || hostname === '127.0.0.1') && protocol.startsWith('http')
}

export let API_BASE = isViteDevHost() ? '' : 'http://127.0.0.1:8765'

export let WS_URL = isViteDevHost()
  ? (window.location.protocol === 'https:' ? 'wss' : 'ws') + '://' + window.location.host + '/ws'
  : 'ws://127.0.0.1:8765/ws'

let apiToken = ''

/** 是否持有令牌。Vite dev 代理下为 false（浏览器不持有令牌，属预期）。 */
export function hasApiToken(): boolean {
  return apiToken.length > 0
}

/**
 * 应用启动时从 Electron 主进程取一次令牌（幂等、绝不抛错）。
 * 非 Electron 环境（纯浏览器 dev）没有 electronAPI，令牌保持为空，
 * 由 dev 代理注入；同时读取后端实际端口（非默认 8765 时修正基址）。
 */
export async function initApiToken(): Promise<void> {
  if (apiToken) return
  const api = (globalThis as any).electronAPI
  if (!api?.invoke) return
  try {
    const [t, port] = await Promise.all([
      api.invoke('app:getApiToken'),
      api.invoke('app:getBackendPort'),
    ])
    if (typeof t === 'string' && t) apiToken = t
    if (typeof port === 'number' && port > 0 && !isViteDevHost()) {
      API_BASE = 'http://127.0.0.1:' + port
      WS_URL = 'ws://127.0.0.1:' + port + '/ws'
    }
  } catch {
    /* dev / 非 Electron：代理注入令牌 */
  }
}

/** 把令牌头并进既有 headers（不持有令牌时原样返回）。 */
export function authHeaders(base?: HeadersInit): HeadersInit | undefined {
  if (!apiToken) return base
  return { ...(base as Record<string, string> | undefined), 'X-Api-Token': apiToken }
}

/** 给无法发送请求头的传输通道（WS、<img>、pdfjs）追加 ?token=。 */
export function withTokenQuery(url: string): string {
  if (!apiToken) return url
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(apiToken)
}

/**
 * 带令牌的 fetch。init 里已带的 method/headers/body 原样保留，
 * 只叠加鉴权头；令牌未初始化时先补一次（避免首请求裸奔 401）。
 */
export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!apiToken) await initApiToken()
  return fetch(url, { ...init, headers: authHeaders(init?.headers) })
}

/** 相对端点 URL（如 /api/files?path=…）→ 绝对 URL。 */
export function absolutize(u: string): string {
  if (/^[a-z][a-z0-9.+-]*:/i.test(u)) return u
  const base = typeof location !== 'undefined' && location?.href
    ? location.href
    : 'http://127.0.0.1:8765/'
  try { return new URL(u, base).toString() } catch { return u }
}
