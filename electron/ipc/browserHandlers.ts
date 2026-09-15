// electron/ipc/browserHandlers.ts
// Bridges renderer Browser panel to local browser automation bridge.
import { ipcMain } from 'electron'
import http from 'http'
import type { IPCContext } from './index'

const BRIDGE_HOST = '127.0.0.1'
const BRIDGE_PORT = 8766

interface BridgeResponse {
  ok: boolean
  value?: any
  error?: string
}

function callBridge(
  endpoint: string,
  token: string | undefined,
  payload: any = {},
  method: 'GET' | 'POST' = 'POST',
  timeoutMs = 40_000,
): Promise<BridgeResponse> {
  return new Promise((resolve) => {
    const body = method === 'POST' ? JSON.stringify(payload ?? {}) : undefined
    const headers: Record<string, string> = token ? { 'X-Bridge-Token': token } : {}
    if (body) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(body))
    }
    const req = http.request(
      {
        host: BRIDGE_HOST,
        port: BRIDGE_PORT,
        path: endpoint,
        method,
        timeout: timeoutMs,
        headers,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e: any) {
            resolve({ ok: false, error: `bad bridge response: ${e.message}` })
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: `bridge timeout after ${timeoutMs}ms` })
    })
    req.on('error', (err) => resolve({ ok: false, error: err.message }))
    if (body) req.write(body)
    req.end()
  })
}

export function registerBrowserHandlers(ctx: IPCContext) {
  const token = ctx.bridgeToken
  ipcMain.handle('browser:status', async () => callBridge('/status', token, {}, 'GET', 5000))
  ipcMain.handle('browser:navigate', async (_e, url: string, visible = true) =>
    callBridge('/navigate', token, { url, visible }),
  )
  ipcMain.handle('browser:click', async (_e, args: { selector?: string; x?: number; y?: number }) =>
    callBridge('/click', token, args),
  )
  ipcMain.handle('browser:fill', async (_e, selector: string, value: string) =>
    callBridge('/fill', token, { selector, value }),
  )
  ipcMain.handle('browser:snapshot', async () => callBridge('/snapshot', token, {}, 'POST', 20_000))
  ipcMain.handle('browser:getText', async () => callBridge('/get_text', token))
  ipcMain.handle('browser:getLinks', async () => callBridge('/get_links', token))
  ipcMain.handle('browser:waitFor', async (_e, selector: string, timeout = 10) =>
    callBridge('/wait_for', token, { selector, timeout }),
  )
  ipcMain.handle('browser:scrollTo', async (_e, y = 0) => callBridge('/scroll_to', token, { y }))
  ipcMain.handle('browser:evaluate', async (_e, code: string) => callBridge('/evaluate', token, { code }))
  ipcMain.handle('browser:resume', async () => callBridge('/resume', token))
  ipcMain.handle('browser:close', async () => callBridge('/close', token))
}
