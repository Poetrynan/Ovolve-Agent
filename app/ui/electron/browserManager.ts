import { app, BrowserWindow, WebContentsView, nativeImage } from 'electron'
import crypto from 'crypto'
import http from 'http'
import path from 'path'
import { getAppIcon } from './main'

export interface BrowserActionResponse {
  ok: boolean
  value?: any
  error?: string
}

/** Largest bridge request body we will buffer (screenshot payloads go the other way). */
const MAX_BODY_BYTES = 2 * 1024 * 1024

export class BrowserManager {
  private browserWindow: BrowserWindow | null = null
  private server: http.Server | null = null
  private currentUrl: string = ''
  private currentState: string = 'idle'
  private isUserTakingOver: boolean = false
  private takeoverResolver: ((value: boolean) => void) | null = null
  public readonly port: number
  /**
   * Shared secret for the local bridge, handed to the Python backend through
   * its environment (see `startPythonBackend`).
   *
   * The bridge drives a real browser: /navigate, /fill and /evaluate together
   * mean "run arbitrary JS on any site, in a window that holds the user's
   * cookies". It used to accept any request that reached the port, and it
   * answered with `Access-Control-Allow-Origin: *`, so any page open in any
   * browser on this machine could both command it and read the results back.
   * A per-run token plus the Origin/Host checks below close that.
   */
  public readonly token: string = crypto.randomBytes(32).toString('hex')
  /** False when the port was already taken, i.e. someone else owns 8766. */
  private bridgeReady = false

  constructor(port = 8766) {
    this.port = port
    this.startHttpBridge()
  }

  /**
   * Start local HTTP bridge server for Python BrowserAgent communication
   */
  private startHttpBridge() {
    this.server = http.createServer(async (req, res) => {
      // No CORS headers at all: the only legitimate client is our own Python
      // process, which is not a browser and does not need them. Anything that
      // *does* need them is by definition a web page we do not want here.
      if (!this.authorize(req, res)) return

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const url = req.url || ''

      if (req.method === 'GET' && url === '/status') {
        this.jsonResponse(res, {
          ok: true,
          value: {
            url: this.currentUrl,
            state: this.currentState,
            isUserTakingOver: this.isUserTakingOver,
            hasWindow: !!this.browserWindow && !this.browserWindow.isDestroyed(),
          },
        })
        return
      }

      if (req.method === 'POST') {
        let body = ''
        let tooLarge = false
        req.on('data', (chunk) => {
          if (tooLarge) return
          body += chunk
          if (body.length > MAX_BODY_BYTES) {
            // Unbounded concatenation on a loopback port is a free way to grow
            // the main process's heap until the app dies.
            tooLarge = true
            this.jsonResponse(res, { ok: false, error: 'Payload too large' }, 413)
            req.destroy()
          }
        })
        req.on('end', async () => {
          if (tooLarge) return
          let payload: any = {}
          try {
            if (body) payload = JSON.parse(body)
          } catch (e) {
            this.jsonResponse(res, { ok: false, error: 'Invalid JSON payload' }, 400)
            return
          }

          try {
            const response = await this.handleRoute(url, payload)
            this.jsonResponse(res, response)
          } catch (err: any) {
            this.jsonResponse(res, { ok: false, error: err?.message || String(err) }, 500)
          }
        })
        return
      }

      this.jsonResponse(res, { ok: false, error: 'Not Found' }, 404)
    })

    this.server.listen(this.port, '127.0.0.1', () => {
      this.bridgeReady = true
      console.log(`[BrowserManager] AI Work Browser HTTP bridge listening on http://127.0.0.1:${this.port}`)
    })

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Not a warning: some other process owns 8766, so every browser command
        // the agent issues — including page text and anything typed by /fill —
        // goes to it instead of us. Refuse to pretend the bridge works.
        this.bridgeReady = false
        this.server = null
        console.error(
          `[BrowserManager] FATAL: port ${this.port} is already in use. ` +
            'The AI work browser is disabled for this run; close whatever owns the port and restart.',
        )
        return
      }
      console.warn(`[BrowserManager] HTTP Bridge error:`, err.message)
    })
  }

  /**
   * Reject anything that is not our Python client.
   *
   * Three independent checks: a constant-time token comparison, no `Origin`
   * header (a browser always sends one on a cross-origin POST, our client
   * never does), and a loopback `Host` (defeats DNS rebinding, where a name
   * the attacker controls resolves to 127.0.0.1 and the request looks local).
   */
  private authorize(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const deny = (reason: string, status = 403) => {
      this.jsonResponse(res, { ok: false, error: reason }, status)
      return false
    }

    if (req.headers.origin) return deny('Origin not allowed on control bridge')

    const host = String(req.headers.host || '')
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
      return deny(`Host not allowed: ${host}`)
    }

    const raw = req.headers['x-bridge-token']
    const provided = Array.isArray(raw) ? raw[0] : raw || ''
    const a = Buffer.from(String(provided))
    const b = Buffer.from(this.token)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return deny('Invalid or missing X-Bridge-Token', 401)
    }
    return true
  }

  /** True once the bridge owns its port. */
  public isBridgeReady(): boolean {
    return this.bridgeReady
  }

  private jsonResponse(res: http.ServerResponse, data: BrowserActionResponse, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }

  /**
   * Route handler for all browser automation actions
   */
  private async handleRoute(endpoint: string, payload: any): Promise<BrowserActionResponse> {
    switch (endpoint) {
      case '/navigate':
        return await this.navigate(payload.url, payload.visible ?? true)
      case '/click':
        return await this.click(payload.selector, payload.x, payload.y)
      case '/fill':
        return await this.fill(payload.selector, payload.value)
      case '/snapshot':
        return await this.snapshot()
      case '/evaluate':
        return await this.evaluate(payload.code)
      case '/get_text':
        return await this.getText()
      case '/get_links':
        return await this.getLinks()
      case '/wait_for':
        return await this.waitFor(payload.selector, payload.timeout ?? 10)
      case '/scroll_to':
        return await this.scrollTo(payload.y ?? 0)
      case '/takeover':
        return await this.promptTakeover(payload.reason || '反爬/验证码或登录检测，请人工接管处理', payload.timeout ?? 300)
      case '/resume':
        return this.resumeFromTakeover()
      case '/close':
        this.closeBrowser()
        return { ok: true, value: 'Browser closed' }
      default:
        return { ok: false, error: `Unknown endpoint: ${endpoint}` }
    }
  }

  /**
   * Get or create the dedicated AI Work Browser window
   */
  private getOrCreateBrowserWindow(visible = true): BrowserWindow {
    if (this.browserWindow && !this.browserWindow.isDestroyed()) {
      if (visible && !this.browserWindow.isVisible()) {
        this.browserWindow.show()
      }
      return this.browserWindow
    }

    const appIcon = getAppIcon()
    const isWin = process.platform === 'win32'
    const iconImg = appIcon
      ? (typeof appIcon === 'string' ? nativeImage.createFromPath(appIcon) : appIcon)
      : undefined

    this.browserWindow = new BrowserWindow({
      title: 'Ovolve AI Work Browser',
      icon: (isWin && typeof appIcon === 'string') ? appIcon : ((iconImg && !iconImg.isEmpty()) ? iconImg : appIcon),
      width: 1100,
      height: 780,
      minWidth: 800,
      minHeight: 600,
      show: visible,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: true,
      },
    })

    if (isWin) {
      try {
        if (typeof appIcon === 'string') {
          this.browserWindow.setIcon(appIcon)
        } else if (iconImg && !iconImg.isEmpty()) {
          this.browserWindow.setIcon(iconImg)
        }
      } catch (_) {}
    }

    this.browserWindow.on('page-title-updated', (e) => {
      // Keep [Ovolve AI Browser] prefix
      if (this.browserWindow) {
        const title = this.browserWindow.getTitle()
        if (!title.startsWith('🤖 [AI Browser]')) {
          this.browserWindow.setTitle(`🤖 [AI Browser] ${title}`)
        }
      }
    })

    this.browserWindow.on('closed', () => {
      this.browserWindow = null
      this.currentState = 'closed'
    })

    return this.browserWindow
  }

  public async navigate(url: string, visible = true): Promise<BrowserActionResponse> {
    if (!url) return { ok: false, error: 'URL is required' }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url
    }

    this.currentState = `Navigating to ${url}`
    const win = this.getOrCreateBrowserWindow(visible)
    this.currentUrl = url
    win.setTitle(`🤖 [AI Browser] 正在加载: ${url}`)

    // 同步广播通知主窗口内嵌 BrowserPanel 跳转
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w !== win && !w.isDestroyed()) {
          w.webContents.send('browser:navigate', url)
        }
      }
    } catch (_) {}

    return new Promise((resolve) => {
      let resolved = false
      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          resolve({ ok: true, value: { url, warning: 'Navigation timeout (25s), continued with loaded state' } })
        }
      }, 25000)

      const finishHandler = () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeoutTimer)
          this.currentState = 'idle'
          win.setTitle(`🤖 [AI Browser] ${win.webContents.getTitle() || url}`)
          resolve({ ok: true, value: { url, title: win.webContents.getTitle() } })
        }
      }

      win.webContents.once('did-finish-load', finishHandler)
      win.webContents.loadURL(url).catch((err) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeoutTimer)
          resolve({ ok: false, error: `Navigation failed: ${err.message}` })
        }
      })
    })
  }

  public async click(selector?: string, x?: number, y?: number): Promise<BrowserActionResponse> {
    const win = this.browserWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'Browser window not open' }

    this.currentState = `Clicking ${selector || `(${x}, ${y})`}`

    if (typeof x === 'number' && typeof y === 'number') {
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      return { ok: true, value: { clicked: `Coordinates (${x}, ${y})` } }
    }

    if (!selector) return { ok: false, error: 'Selector or coordinates required for click' }

    const jsCode = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        el.click();
        return { ok: true, tag: el.tagName, text: el.innerText ? el.innerText.slice(0, 50) : '' };
      })()
    `

    try {
      const result = await win.webContents.executeJavaScript(jsCode)
      this.currentState = 'idle'
      return result.ok ? { ok: true, value: result } : { ok: false, error: result.error }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  public async fill(selector: string, value: string): Promise<BrowserActionResponse> {
    const win = this.browserWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'Browser window not open' }

    this.currentState = `Filling ${selector}`

    const jsCode = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: ${JSON.stringify(value)} };
      })()
    `

    try {
      const result = await win.webContents.executeJavaScript(jsCode)
      this.currentState = 'idle'
      return result.ok ? { ok: true, value: result } : { ok: false, error: result.error }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  public async snapshot(): Promise<BrowserActionResponse> {
    const win = this.browserWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'Browser window not open' }

    try {
      const image = await win.webContents.capturePage()
      const dataUri = image.toDataURL()
      return { ok: true, value: { dataUri, width: image.getSize().width, height: image.getSize().height } }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  public async evaluate(code: string): Promise<BrowserActionResponse> {
    const win = this.browserWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'Browser window not open' }

    try {
      const value = await win.webContents.executeJavaScript(code)
      return { ok: true, value }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  public async getText(): Promise<BrowserActionResponse> {
    const win = this.browserWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'Browser window not open' }

    try {
      const text = await win.webContents.executeJavaScript('document.body.innerText')
      return { ok: true, value: text }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  public async getLinks(): Promise<BrowserActionResponse> {
    const win = this.browserWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'Browser window not open' }

    const jsCode = `
      (() => {
        return Array.from(document.querySelectorAll('a'))
          .map(a => ({ text: a.innerText.trim(), href: a.href }))
          .filter(item => item.href && item.href.startsWith('http'))
          .slice(0, 100);
      })()
    `

    try {
      const links = await win.webContents.executeJavaScript(jsCode)
      return { ok: true, value: links }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  public async waitFor(selector: string, timeoutSec = 10): Promise<BrowserActionResponse> {
    const win = this.browserWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'Browser window not open' }

    const startTime = Date.now()
    const maxMs = timeoutSec * 1000

    while (Date.now() - startTime < maxMs) {
      try {
        const found = await win.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`)
        if (found) return { ok: true, value: { selector, found: true, elapsedMs: Date.now() - startTime } }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 250))
    }

    return { ok: false, error: `Timeout waiting for selector: ${selector} (${timeoutSec}s)` }
  }

  public async scrollTo(y: number): Promise<BrowserActionResponse> {
    const win = this.browserWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'Browser window not open' }

    try {
      await win.webContents.executeJavaScript(`window.scrollTo({ top: ${y}, behavior: 'smooth' })`)
      return { ok: true, value: { scrolledToY: y } }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  /**
   * Prompt user for manual takeover (SOP Stage 8: Human In The Loop)
   */
  public async promptTakeover(reason: string, timeoutSec = 300): Promise<BrowserActionResponse> {
    const win = this.getOrCreateBrowserWindow(true)
    win.show()
    win.focus()
    this.isUserTakingOver = true
    this.currentState = `[等待人工接管] ${reason}`
    win.setTitle(`⚠️ [人工接管请求] ${reason} - 请在窗口中完成操作`)

    console.log(`[BrowserManager] Human Takeover initiated: ${reason}. Waiting for user completion...`)

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.isUserTakingOver) {
          this.isUserTakingOver = false
          this.takeoverResolver = null
          resolve({ ok: false, error: `人工接管等待超时 (${timeoutSec}秒)` })
        }
      }, timeoutSec * 1000)

      this.takeoverResolver = (resumed: boolean) => {
        clearTimeout(timer)
        this.isUserTakingOver = false
        this.currentState = 'idle'
        win.setTitle(`🤖 [AI Browser] ${win.webContents.getTitle()}`)
        resolve({ ok: true, value: { message: '人工接管完成，AI 自动化已恢复。' } })
      }
    })
  }

  public resumeFromTakeover(): BrowserActionResponse {
    if (this.takeoverResolver) {
      this.takeoverResolver(true)
      this.takeoverResolver = null
      return { ok: true, value: 'Resumed AI automation' }
    }
    return { ok: false, error: 'No active takeover session to resume' }
  }

  public closeBrowser() {
    if (this.browserWindow && !this.browserWindow.isDestroyed()) {
      this.browserWindow.close()
      this.browserWindow = null
    }
    this.currentState = 'closed'
  }

  public destroy() {
    this.closeBrowser()
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }
}
