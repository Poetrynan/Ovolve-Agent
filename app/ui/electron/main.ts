import { app, BrowserWindow, dialog, ipcMain, nativeImage, screen, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import http from 'http'
import { API_TOKEN } from './apiToken'
import { spawn, ChildProcess } from 'child_process'
import treeKill from 'tree-kill'
import { BrowserManager } from './browserManager'
import { registerAllIpc } from './ipc'
import { initPathScope } from './pathScope'
import { createTray, destroyTray, getCloseToTray, getIsQuitting, setIsQuitting } from './tray'
import { pickServerPorts, writeDevBackendPort } from './serverPorts'

// Set AppUserModelId for Windows taskbar grouping and identity.
// MUST be a consistent application ID ('com.ovolve.desktop') in both dev and production.
// NEVER use process.execPath in dev mode, because that binds the taskbar window to electron.exe,
// which causes Windows Shell to override the window icon with Electron's default atom icon.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.ovolve.desktop')
}

// Chrome DevTools Protocol, for driving the app from Playwright / Puppeteer.
//
// Opt-in, and dev-only. CDP is a full remote-control channel: anything that can
// reach the port can evaluate JavaScript in every window, read the renderer's
// memory and drive the UI, with no authentication of any kind. It used to be
// switched on unconditionally, including in packaged builds, together with
// `remote-allow-origins=*` -- which tells Chromium to accept a CDP WebSocket
// from *any* Origin, so a page the user merely visits in their normal browser
// could attach to this app. Nothing in the codebase connects to 9222 (the
// Python BrowserAgent talks to the 8766 bridge instead), so the default is off.
const isDev = !app.isPackaged || Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.OVOLVE_DEV_MODE === '1'

if (isDev && (process.env.OVOLVE_ENABLE_CDP ?? process.env.OVOLVE_ENABLE_CDP) === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
  // Loopback only, and no Origin wildcard: an automation client on this
  // machine still works, a remote page does not.
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  console.warn('[electron] CDP enabled on 127.0.0.1:9222 (OVOLVE_ENABLE_CDP=1)')
}

let mainWindow: BrowserWindow | null = null
//: Every live app window, including `mainWindow`. Multi-window exists so the
//: user can watch two workspaces side by side; the Python backend still holds
//: ONE router, so all windows share one active workspace — see
//: `_broadcast_workspace_list` on the backend, which keeps every window's
//: sidebar honest about that instead of letting stale views lie.
const appWindows = new Set<BrowserWindow>()
let browserManager: BrowserManager | null = null
let pythonProcess: ChildProcess | null = null
let isShuttingDown = false
/** HTTP/WS API port for *this* Electron instance (dynamic when 8765 is taken). */
let backendPort = 8765

/**
 * Locate python main.py across development and production environments
 */
function findPythonScript(): string | null {
  const scriptOverride = process.env.OVOLVE_PYTHON_PATH
  if (scriptOverride && fs.existsSync(scriptOverride)) {
    return path.resolve(scriptOverride)
  }

  const isDevRunning = !app.isPackaged || Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.OVOLVE_DEV_MODE === '1'
  const candidates: string[] = []

  if (isDevRunning) {
    // Relative to compiled electron main.js (dist-electron/main.js -> app/main.py)
    candidates.push(path.resolve(__dirname, '../../main.py'))
    candidates.push(path.resolve(app.getAppPath(), '../main.py'))
    candidates.push(path.resolve(process.cwd(), '../main.py'))
    candidates.push(path.resolve(process.cwd(), 'app/main.py'))
    candidates.push(path.resolve(process.cwd(), 'main.py'))
    candidates.push(path.resolve(__dirname, '../main.py'))
  } else {
    // Packaged via electron-builder (resources/app/main.py or resources/main.py)
    candidates.push(path.join(process.resourcesPath, 'app/main.py'))
    candidates.push(path.join(process.resourcesPath, 'main.py'))
    candidates.push(path.join(app.getAppPath(), 'app/main.py'))
    // Fallback if launched in repository workspace with patched executable
    candidates.push(path.resolve(app.getAppPath(), '../main.py'))
    candidates.push(path.resolve(__dirname, '../../main.py'))
    candidates.push(path.resolve(process.cwd(), '../main.py'))
    candidates.push(path.resolve(process.cwd(), 'app/main.py'))
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.resolve(candidate)
    }
  }

  return null
}

/**
 * Locate the primary Python executable on the host system.
 */
function findPythonBinary(): string {
  const binOverride = process.env.OVOLVE_PYTHON_BIN
  if (binOverride && fs.existsSync(binOverride)) {
    return binOverride
  }

  const userProfile = process.env.USERPROFILE || ''
  const knownPaths = [
    'D:\\Anaconda\\python.exe',
    'C:\\Python313\\python.exe',
    'C:\\Python312\\python.exe',
    'C:\\Python311\\python.exe',
    'C:\\Python310\\python.exe',
    path.join(userProfile, 'anaconda3\\python.exe'),
    path.join(userProfile, 'miniconda3\\python.exe'),
    path.join(userProfile, 'AppData\\Local\\Programs\\Python\\Python313\\python.exe'),
    path.join(userProfile, 'AppData\\Local\\Programs\\Python\\Python312\\python.exe'),
    path.join(userProfile, 'AppData\\Local\\Programs\\Python\\Python311\\python.exe'),
  ]

  for (const p of knownPaths) {
    if (fs.existsSync(p)) return p
  }

  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process')
      const out = execSync('where.exe python', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const lines = out.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean)
      for (const line of lines) {
        if (!line.includes('WindowsApps') && line.toLowerCase().endsWith('python.exe') && fs.existsSync(line)) {
          return line
        }
      }
    } catch (_) {}
  }

  return 'python'
}

/**
 * Shared secret for the local HTTP/WS API (:8765).
 *
 * Minted in `./apiToken` so the main-process backend callers (ipc/modelHandlers)
 * use the identical value — a second generation site would authenticate nothing.
 * Handed to the Python child through the environment (never a command line,
 * which is world-readable in `ps`) and to the renderer over IPC below.
 */
ipcMain.handle('app:getApiToken', () => API_TOKEN)
ipcMain.handle('app:getBackendPort', () => backendPort)

/**
 * Spawn the Python backend server
 */
function startPythonBackend(scriptPath: string): ChildProcess | null {
  const workingDir = path.dirname(scriptPath)
  const pythonBin = findPythonBinary()

  console.log(`[electron] Starting Python backend: python='${pythonBin}', script='${scriptPath}', cwd='${workingDir}'`)

  try {
    const child = spawn(pythonBin, [scriptPath, '--server'], {
      cwd: workingDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONPATH: [
          path.join(workingDir, 'backend'),
          workingDir,
          process.env.PYTHONPATH || '',
        ].filter(Boolean).join(path.delimiter),
        PYTHONUNBUFFERED: '1',
        PYTHONWARNINGS: 'ignore',
        // Local API secret for the :8765 HTTP/WS server. The renderer gets the
        // same value over app:getApiToken; the backend reads it from here (see
        // api_auth.get_api_token). Env, not argv, so it stays out of `ps`.
        // Injected under both names during the Ovolve→Ovolve rename so an
        // older backend build still authenticates.
        OVOLVE_API_TOKEN: API_TOKEN,
        OVOLVE_SERVER_PORT: String(backendPort),
        ...(browserManager ? {
          OVOLVE_BRIDGE_TOKEN: browserManager.token,
          OVOLVE_BRIDGE_PORT: String(browserManager.port),
        } : {}),
      },
    })


    child.stdout?.on('data', (data) => {
      const line = data.toString().trim()
      if (line) console.log(`[backend] ${line}`)
    })

    child.stderr?.on('data', (data) => {
      const line = data.toString().trim()
      if (line) console.error(`[backend:err] ${line}`)
    })

    child.on('error', (err) => {
      console.warn(`[electron] Python backend process error: ${err.message}`)
    })

    child.on('exit', (code, signal) => {
      console.log(`[backend] Python process exited with code ${code}, signal ${signal}`)
      pythonProcess = null
    })

    console.log(`[electron] Successfully spawned Python backend using '${pythonBin}' (PID: ${child.pid})`)
    return child
  } catch (err: any) {
    console.error(`[electron] Failed to spawn Python backend with '${pythonBin}': ${err?.message || err}`)
    return null
  }
}

/**
 * Poll the backend health endpoint until it is ready
 */
function waitForBackendReady(maxAttempts = 80, intervalMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    let attempts = 0
    const check = () => {
      attempts++
      const req = http.get(`http://127.0.0.1:${backendPort}/api/health`, (res) => {
        res.resume()
        if (res.statusCode === 200) {
          console.log(`[electron] Backend is healthy on :${backendPort} (after ${attempts} checks).`)
          resolve(true)
        } else {
          retry()
        }
      })

      req.on('error', () => {
        retry()
      })

      req.setTimeout(800, () => {
        req.destroy()
        retry()
      })
    }

    const retry = () => {
      if (attempts >= maxAttempts) {
        console.warn(`[electron] Backend health check timed out on :${backendPort} after ${attempts} attempts. Continuing anyway.`)
        resolve(false)
      } else {
        setTimeout(check, intervalMs)
      }
    }

    check()
  })
}

/**
 * Confirm that the process answering on :8765 is *ours*.
 *
 * `waitForBackendReady` above proves only that something is alive there, and it
 * cannot prove more: `/api/health` is deliberately exempt from auth, because
 * Electron polls it before the window exists — i.e. before anything could
 * present a token. So a leftover backend from an earlier run, or one started by
 * hand in a terminal, answers that probe with a cheerful 200 while holding a
 * *different* secret. The window then opens and every authenticated call fails
 * with `api token required`, which reads like a bug in each individual page
 * rather than what it is: a stale process squatting on the port.
 *
 * The distinguishing signal is a 401 on a path that is NOT exempt. Any other
 * outcome means the middleware let us past, so the token matches — 404 and 500
 * included. Route coverage is irrelevant here; only the auth verdict is.
 */
function verifyBackendIdentity(): Promise<'ok' | 'foreign' | 'unreachable'> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: backendPort,
        path: '/api/evolution/mode',
        headers: { 'X-Api-Token': API_TOKEN },
      },
      (res) => {
        res.resume() // drain, or the socket stays open
        resolve(res.statusCode === 401 ? 'foreign' : 'ok')
      },
    )
    req.on('error', () => resolve('unreachable'))
    req.setTimeout(1500, () => {
      req.destroy()
      resolve('unreachable')
    })
  })
}

/**
 * Kill the Python backend process and all its child sub-processes cleanly
 */
function cleanupBackend() {
  if (isShuttingDown) return
  isShuttingDown = true

  try {
    browserManager?.destroy()
    browserManager = null
  } catch (_) {}

  if (pythonProcess && pythonProcess.pid) {
    const pid = pythonProcess.pid
    console.log(`[electron] Killing Python backend process tree (PID: ${pid})...`)
    try {
      treeKill(pid, 'SIGTERM', (err) => {
        if (err) {
          console.warn(`[electron] SIGTERM failed, forcing SIGKILL on PID ${pid}: ${err.message}`)
          try {
            treeKill(pid, 'SIGKILL')
          } catch (_) {}
        }
      })
    } catch (e: any) {
      console.error(`[electron] Error killing backend: ${e?.message || e}`)
    }
    pythonProcess = null
  }
}

/**
 * Locate the application icon for window and taskbar
 */
export function getAppIcon(): Electron.NativeImage | string | undefined {
  const isDevRunning = !app.isPackaged || Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.OVOLVE_DEV_MODE === '1'
  const isWin = process.platform === 'win32'

  const candidates: string[] = []
  if (isDevRunning) {
    if (isWin) {
      candidates.push(
        path.join(__dirname, 'icon.ico'),
        path.resolve(__dirname, '../public/icon.ico'),
        path.resolve(process.cwd(), 'public/icon.ico'),
        path.resolve(process.cwd(), 'app/ui/public/icon.ico'),
        path.resolve(app.getAppPath(), 'public/icon.ico'),
        path.resolve(app.getAppPath(), '../public/icon.ico'),
      )
    }
    candidates.push(
      path.join(__dirname, 'icon.png'),
      path.resolve(__dirname, '../public/icon.png'),
      path.resolve(process.cwd(), 'public/icon.png'),
      path.resolve(process.cwd(), 'app/ui/public/icon.png'),
      path.resolve(app.getAppPath(), 'public/icon.png'),
      path.resolve(app.getAppPath(), '../public/icon.png'),
    )
  } else {
    if (isWin) {
      candidates.push(
        path.join(process.resourcesPath, 'app/dist/icon.ico'),
        path.join(process.resourcesPath, 'dist/icon.ico'),
        path.join(process.resourcesPath, 'icon.ico'),
        path.join(__dirname, 'icon.ico'),
        path.join(__dirname, '../dist/icon.ico'),
        path.join(app.getAppPath(), 'dist/icon.ico'),
        path.resolve(__dirname, '../public/icon.ico'),
        path.resolve(app.getAppPath(), 'public/icon.ico'),
      )
    }
    candidates.push(
      path.join(process.resourcesPath, 'app/dist/icon.png'),
      path.join(process.resourcesPath, 'dist/icon.png'),
      path.join(process.resourcesPath, 'icon.png'),
      path.join(__dirname, 'icon.png'),
      path.join(__dirname, '../dist/icon.png'),
      path.join(app.getAppPath(), 'dist/icon.png'),
      path.resolve(__dirname, '../public/icon.png'),
      path.resolve(app.getAppPath(), 'public/icon.png'),
    )
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      console.log(`[electron] Successfully resolved icon path: ${c}`)
      if (isWin && c.endsWith('.ico')) {
        // On Windows, passing direct file path to .ico guarantees native HICON extraction by Win32 API
        return c
      }
      try {
        const img = nativeImage.createFromPath(c)
        if (!img.isEmpty()) return img
      } catch (_) {}
      return c
    }
  }
  console.warn('[electron] WARNING: Could not find application icon!')
  return undefined
}

/**
 * Create and configure an application window.
 *
 * `opts.workspace` seeds the renderer with a `?workspace=<path>` query param so
 * the new window switches the agent to that folder once its WebSocket is up.
 * The first window created becomes `mainWindow` (the one dialogs parent to);
 * later ones are tracked in `appWindows` only.
 */
function createWindow(opts: { workspace?: string } = {}): BrowserWindow {
  const appIcon = getAppIcon()
  const isWin = process.platform === 'win32'
  const iconImg = appIcon
    ? (typeof appIcon === 'string' ? nativeImage.createFromPath(appIcon) : appIcon)
    : undefined
  const isPrimary = mainWindow === null || mainWindow.isDestroyed()

  // The layout has three regions that must all be readable on first launch:
  // the left nav rail, the chat center, and the right workspace panel. Below
  // ~1180px the right panel's tab labels start truncating, so treat that as
  // the floor and otherwise open nearly full-screen (capped so it stays a
  // window rather than a pseudo-maximized one on large monitors).
  const { workAreaSize } = screen.getPrimaryDisplay()
  const minWinWidth = Math.min(1180, workAreaSize.width)
  const minWinHeight = Math.min(720, workAreaSize.height)
  const winWidth = Math.min(1600, Math.max(minWinWidth, workAreaSize.width - 80))
  const winHeight = Math.min(1000, Math.max(minWinHeight, workAreaSize.height - 80))

  const win = new BrowserWindow({
    title: 'Ovolve',
    icon: (isWin && typeof appIcon === 'string') ? appIcon : ((iconImg && !iconImg.isEmpty()) ? iconImg : appIcon),
    width: winWidth,
    height: winHeight,
    minWidth: minWinWidth,
    minHeight: minWinHeight,
    center: true,
    show: false,
    // Frameless with a custom in-app title bar. On macOS keep the
    // native traffic lights via `hiddenInset`; on Windows/Linux go fully custom.
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // Match the app's dark theme instead of pure black — pure black reads as
    // "app is dead" during the ~50ms React mount window.
    backgroundColor: '#131210',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // Enable the <webview> tag so the AI Work Browser can embed a live,
      // interactive page inside the panel (VSCode Simple Browser style) rather
      // than spawning a separate OS window.
      webviewTag: true,
    },
  })

  // Explicitly set window icon for Windows taskbar and Alt+Tab binding
  if (isWin) {
    try {
      if (typeof appIcon === 'string') {
        win.setIcon(appIcon)
      } else if (iconImg && !iconImg.isEmpty()) {
        win.setIcon(iconImg)
      }
    } catch (e) {
      console.warn('[electron] win.setIcon warning:', e)
    }
  }

  if (isPrimary) mainWindow = win
  appWindows.add(win)

  // Minimize-to-tray on close for the primary window.
  //
  // Rationale: for an agent app, "user clicks X" means "get out of my way",
  // not "kill everything in flight". We hide the window, keep the Python
  // backend alive, and let the tray icon serve as the way back in. The real
  // quit path is the tray "Quit Ovolve" item (see tray.ts) — that one sets
  // `isQuitting = true` first, so this handler lets the close through.
  //
  // Secondary workspace windows keep the normal destroy-on-close behavior:
  // they exist so the user can watch two workspaces side by side, so hiding
  // them would be surprising. Only the last remaining app window is treated
  // as the "app" for tray purposes.
  if (isPrimary) {
    win.on('close', (e) => {
      if (getIsQuitting()) return          // real shutdown, let it through
      if (!getCloseToTray()) return        // user opted into quit-on-close
      // Do not hide-to-tray if a second window is still around — the user
      // probably meant to close *this* one, not the whole app.
      const otherLive = [...appWindows].some((w) => w !== win && !w.isDestroyed())
      if (otherLive) return
      e.preventDefault()
      win.hide()
    })
  }



  // ── Keyboard shortcuts handler ───────────────────────────────────────────
  // • In dev mode (hot reload / debugging): F5, Ctrl+R, Ctrl+Shift+R reload page, F12 opens DevTools
  // • In production packaged .exe: F5 / Ctrl+R are disabled to protect in-flight agent state
  const isDev = !app.isPackaged || Boolean(process.env.VITE_DEV_SERVER_URL)

  win.webContents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase()

    // ⌘N / Ctrl+N — new conversation. Fires globally so it works from any
    // page/panel without the input needing focus. The renderer picks it up
    // via the IPC event and calls sessionListStore.newSession().
    if ((input.meta || input.control) && key === 'n' && !input.shift && !input.alt) {
      win.webContents.send('app:new-session')
      event.preventDefault()
      return
    }

    if (isDev) {
      // Toggle DevTools (F12 or Ctrl+Shift+I)
      if (key === 'f12' || (input.control && input.shift && key === 'i') || (input.meta && input.shift && key === 'i')) {
        win.webContents.toggleDevTools()
        event.preventDefault()
        return
      }

      // Live reload shortcuts in dev mode: F5, Ctrl+R, Ctrl+Shift+R, Meta+R
      if (key === 'f5' || (input.control && key === 'r') || (input.meta && key === 'r')) {
        if (input.shift || input.control) {
          win.webContents.reloadIgnoringCache()
        } else {
          win.webContents.reload()
        }
        event.preventDefault()
        return
      }
    } else {
      // Production packaged release (.exe): suppress F5 / Ctrl+R to avoid losing state
      const isReload =
        key === 'f5' ||
        (input.control && key === 'r') ||
        (input.meta && key === 'r') ||
        (input.control && input.shift && key === 'r') ||
        (input.meta && input.shift && key === 'r')
      if (isReload) event.preventDefault()
    }
  })

  // Show the window as soon as the renderer's first paint is committed.
  // Fall back to `did-finish-load` and finally a hard timeout — if any of these
  // fire and the window is still hidden, force it visible. Without this belt-
  // and-braces the window could stay black forever if `ready-to-show` is
  // starved by a renderer error.
  const forceShow = () => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show()
      win.focus()
    }
  }
  win.once('ready-to-show', forceShow)
  win.webContents.once('did-finish-load', () => setTimeout(forceShow, 200))
  setTimeout(forceShow, 4000)

  // Broadcast maximize/unmaximize so the custom title bar can swap its icon.
  const emitState = () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:state', { maximized: win.isMaximized() })
  }
  win.on('maximize', emitState)
  win.on('unmaximize', emitState)

  // Detect dev mode via env or unpackaged state
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  const wsQuery = opts.workspace ? { workspace: opts.workspace } : undefined

  // ── Renderer containment ─────────────────────────────────────────────────
  // This window hosts our own UI *and* <webview> tags pointing at arbitrary
  // remote pages (the AI work browser). Electron's defaults are permissive in
  // exactly the places that matters: a <webview> can request nodeIntegration
  // and inherit this window's preload, `window.open` opens a child window with
  // the same webPreferences (preload bridge included), and a top-level
  // navigation can swap the trusted UI for a remote page that then talks to
  // `window.electronAPI`. All three are denied below.
  const distDir = path.resolve(__dirname, '../dist')

  const isTrustedAppUrl = (raw: string): boolean => {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      return false
    }
    if (u.protocol === 'file:') {
      // Packaged build: only files from our own bundle directory.
      const p = path.resolve(decodeURIComponent(u.pathname).replace(/^\/(?=[a-zA-Z]:)/, ''))
      return p === distDir || p.startsWith(distDir + path.sep)
    }
    return Boolean(devServerUrl) && raw.startsWith(devServerUrl as string)
  }

  win.webContents.on('will-navigate', (e, url) => {
    if (isTrustedAppUrl(url)) return
    e.preventDefault()
    console.warn('[electron] blocked top-level navigation:', url)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    // A child BrowserWindow would inherit this window's preload, so a link in
    // rendered model output could open a page holding the IPC bridge. Hand
    // http(s) to the OS browser instead and deny everything else outright.
    try {
      const proto = new URL(url).protocol
      if (proto === 'http:' || proto === 'https:') shell.openExternal(url)
      else console.warn('[electron] blocked window.open scheme:', url)
    } catch {
      console.warn('[electron] blocked malformed window.open target:', url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    // Whatever the renderer asked for, the embedded page gets no privileges.
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    // A <webview> is for browsing the web. `file:` would turn the panel into a
    // local file reader that renders whatever the model points it at.
    const src = String(params.src ?? '')
    if (src && !/^(https?:|about:blank$)/.test(src)) {
      e.preventDefault()
      console.warn('[electron] blocked webview src scheme:', src)
    }
  })

  win.webContents.on('did-attach-webview', (_e, guest) => {
    // The panel sets `allowpopups`, so the guest can call window.open. Its
    // popups are its own webContents' business, not the parent's, so the guest
    // needs the same deny-and-hand-to-OS rule.
    guest.setWindowOpenHandler(({ url }) => {
      try {
        const proto = new URL(url).protocol
        if (proto === 'http:' || proto === 'https:') shell.openExternal(url)
      } catch {
        // malformed target — deny silently
      }
      return { action: 'deny' }
    })
  })



  if (devServerUrl) {
    const suffix = opts.workspace ? `?workspace=${encodeURIComponent(opts.workspace)}` : ''
    win.loadURL(`${devServerUrl}${suffix}`)
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'), wsQuery ? { query: wsQuery } : undefined)
  }

  // Surface renderer load failures — otherwise the window just sits there dark
  // and there is nothing in the logs to explain it.
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[electron] renderer failed to load: ${code} ${desc} — ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[electron] renderer process gone: ${JSON.stringify(details)}`)
  })

  win.on('closed', () => {
    appWindows.delete(win)
    if (mainWindow === win) {
      // Promote a surviving window so dialogs and title-bar IPC keep a parent.
      const next = [...appWindows].find((w) => !w.isDestroyed())
      mainWindow = next ?? null
    }
  })

  return win
}


// Multiple instances are allowed (Ovolve, or several dev windows).
// Each instance binds its own backend/bridge port pair via pickServerPorts().

app.whenReady().then(async () => {
    const ports = await pickServerPorts()
    backendPort = ports.backend
    process.env.OVOLVE_SERVER_PORT = String(ports.backend)
    process.env.OVOLVE_BRIDGE_PORT = String(ports.bridge)
    writeDevBackendPort(
      backendPort,
      parseInt(process.env.VITE_DEV_PORT || '', 10) || undefined,
    )

    browserManager = new BrowserManager(ports.bridge)

    const userDataDir = app.getPath('userData')
    const configRoot = path.join(userDataDir, 'ovolve')
    try {
      fs.mkdirSync(configRoot, { recursive: true })
    } catch (_) {}
    // Seed the filesystem fence before any handler can run: file:* / git:*
    // paths are checked against granted roots, and configRoot is the first one.
    initPathScope(configRoot)
    registerAllIpc({
      getMainWindow: () => mainWindow,
      configRoot,
      bridgeToken: browserManager?.token,
      openWorkspaceWindow: (workspacePath: string) => createWindow({ workspace: workspacePath }),
    })

    const scriptPath = findPythonScript()
    if (scriptPath) {
      pythonProcess = startPythonBackend(scriptPath)
    } else {
      console.error('[electron] WARNING: Could not find app/main.py script!')
    }

    // Wait for Python backend /api/health before displaying UI
    await waitForBackendReady()

    // …then check *whose* backend it is. Liveness is not identity: a stale
    // process on :8765 passes the health probe and fails every authed call.
    const backendIdentity = await verifyBackendIdentity()
    if (backendIdentity === 'foreign') {
      const msg =
        `端口 ${backendPort} 被另一个 Ovolve 后端占用，它持有的 API token 与本次启动的不一致。\n\n` +
        '结果是所有需要鉴权的接口都会返回「api token required」（演化裁决、演化、用量等页面全部加载失败），' +
        '而健康检查仍然通过——因为 /api/health 是免鉴权的。\n\n' +
        `处理方法：结束占用 ${backendPort} 的那个 python 进程，然后重启本应用。\n` +
        `查找它：powershell -c "Get-NetTCPConnection -LocalPort ${backendPort} -State Listen"`
      console.error('[electron] ' + msg.replace(/\n+/g, ' '))
      dialog.showErrorBox('后端 token 不匹配', msg)
    }

    createWindow()

    // Tray last, so `getMainWindow()` already resolves to a live window when
    // the menu is first built (the labels depend on window visibility).
    createTray({
      getMainWindow: () => mainWindow,
      sendToMain: (channel, payload) => {
        try {
          mainWindow?.webContents.send(channel, payload)
        } catch (_) { /* window torn down mid-click */ }
      },
      quit: () => {
        // Order matters: flip the flag BEFORE app.quit() so the primary
        // window's close handler stops preventing the close.
        setIsQuitting(true)
        app.quit()
      },
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

app.on('window-all-closed', () => {
    cleanupBackend()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

app.on('before-quit', () => {
    // Anything that reaches before-quit is a real shutdown — the menu bar,
    // an OS logoff, `app.quit()` from the tray. Flip the flag so the
    // minimize-to-tray close handler stands down, then tear down the backend
    // and the tray icon (a stale tray icon lingering after exit is the classic
    // "unfinished app" tell).
    setIsQuitting(true)
    destroyTray()
    cleanupBackend()
  })

process.on('SIGINT', () => {
    setIsQuitting(true)
    cleanupBackend()
    process.exit(0)
  })

process.on('SIGTERM', () => {
    setIsQuitting(true)
    cleanupBackend()
    process.exit(0)
  })

process.on('exit', () => {
  cleanupBackend()
})
