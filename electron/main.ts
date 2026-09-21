import { app, BrowserWindow, screen, shell, nativeImage, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import http from 'http'
import { spawn, type ChildProcess } from 'child_process'
import treeKill from 'tree-kill'
import { fileURLToPath } from 'url'
import { registerAllIpc } from './ipc/index'
import { initPathScope } from './pathScope'
import { createTray, destroyTray, getCloseToTray, getIsQuitting, setIsQuitting } from './tray'
import { API_TOKEN } from './apiToken'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

if (process.platform === 'win32') {
  app.setAppUserModelId('com.ovolve.desktop')
}

let mainWindow: BrowserWindow | null = null
const appWindows = new Set<BrowserWindow>()
let pythonProcess: ChildProcess | null = null
let isShuttingDown = false

ipcMain.handle('app:getApiToken', () => API_TOKEN)

function findPythonScript(): string | null {
  const override = process.env.OVOLVE_PYTHON_PATH
  if (override && fs.existsSync(override)) return path.resolve(override)

  const candidates = [
    path.resolve(__dirname, '../../app/main.py'),
    path.resolve(__dirname, '../app/main.py'),
    path.resolve(process.cwd(), 'app/main.py'),
    path.resolve(app.getAppPath(), 'app/main.py'),
    path.join(process.resourcesPath, 'app/main.py'),
    'd:/Ovolve Agent/app/main.py',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

function findPythonBinary(): string {
  const override = process.env.OVOLVE_PYTHON_BIN
  if (override && fs.existsSync(override)) return override
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process')
      const out = execSync('where.exe python', { encoding: 'utf8' })
      for (const line of out.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean)) {
        if (!line.includes('WindowsApps') && fs.existsSync(line)) return line
      }
    } catch (_) {}
  }
  return 'python'
}

function startPythonBackend(scriptPath: string): ChildProcess | null {
  const workingDir = path.dirname(scriptPath)
  const pythonBin = findPythonBinary()
  console.log(`[electron] Starting Python backend: ${pythonBin} ${scriptPath}`)
  try {
    const child = spawn(pythonBin, [scriptPath, '--server'], {
      cwd: workingDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONPATH: path.join(workingDir, 'backend'),
        PYTHONUNBUFFERED: '1',
        OVOLVE_API_TOKEN: API_TOKEN,
      },
    })
    child.stdout?.on('data', (d) => {
      const line = d.toString().trim()
      if (line) console.log(`[backend] ${line}`)
    })
    child.stderr?.on('data', (d) => {
      const line = d.toString().trim()
      if (line) console.error(`[backend:err] ${line}`)
    })
    child.on('exit', () => {
      pythonProcess = null
    })
    return child
  } catch (e: any) {
    console.error(`[electron] Failed to spawn Python: ${e?.message}`)
    return null
  }
}

function waitForBackendReady(maxAttempts = 40, intervalMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let attempts = 0
    const check = () => {
      attempts++
      const req = http.get('http://127.0.0.1:8765/api/health', (res) => {
        if (res.statusCode === 200) resolve(true)
        else retry()
      })
      req.on('error', () => retry())
      req.setTimeout(800, () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (attempts >= maxAttempts) resolve(false)
      else setTimeout(check, intervalMs)
    }
    check()
  })
}

function verifyBackendIdentity(): Promise<'ok' | 'foreign' | 'unreachable'> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: 8765, path: '/api/evolution/mode', headers: { 'X-Api-Token': API_TOKEN } },
      (res) => {
        res.resume()
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

function cleanupBackend() {
  if (isShuttingDown) return
  isShuttingDown = true
  if (pythonProcess?.pid) {
    treeKill(pythonProcess.pid, 'SIGTERM', () => {
      try {
        treeKill(pythonProcess!.pid!, 'SIGKILL')
      } catch (_) {}
    })
    pythonProcess = null
  }
}

export function getAppIcon(): Electron.NativeImage | string | undefined {
  const isDev = !app.isPackaged
  const isWin = process.platform === 'win32'
  const candidates: string[] = []

  if (isDev) {
    if (isWin) {
      candidates.push(
        path.resolve(process.cwd(), 'public/icon.ico'),
        path.resolve(app.getAppPath(), 'public/icon.ico'),
      )
    }
    candidates.push(
      path.resolve(process.cwd(), 'public/icon.png'),
      path.resolve(app.getAppPath(), 'public/icon.png'),
    )
  } else {
    if (isWin) {
      candidates.push(
        path.join(process.resourcesPath, 'app/dist/icon.ico'),
        path.join(process.resourcesPath, 'dist/icon.ico'),
        path.join(process.resourcesPath, 'icon.ico'),
        path.join(app.getAppPath(), 'dist/icon.ico'),
      )
    }
    candidates.push(
      path.join(process.resourcesPath, 'app/dist/icon.png'),
      path.join(process.resourcesPath, 'dist/icon.png'),
      path.join(process.resourcesPath, 'icon.png'),
      path.join(app.getAppPath(), 'dist/icon.png'),
    )
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      if (isWin && c.endsWith('.ico')) return c
      try {
        const img = nativeImage.createFromPath(c)
        if (!img.isEmpty()) return img
      } catch (_) {}
      return c
    }
  }
  return undefined
}

function createWindow(opts: { workspace?: string } = {}): BrowserWindow {
  const appIcon = getAppIcon()
  const isWin = process.platform === 'win32'
  const iconImg = appIcon
    ? typeof appIcon === 'string'
      ? nativeImage.createFromPath(appIcon)
      : appIcon
    : undefined
  const isPrimary = mainWindow === null || mainWindow.isDestroyed()

  const { workAreaSize } = screen.getPrimaryDisplay()
  const minWinWidth = Math.min(1080, workAreaSize.width)
  const minWinHeight = Math.min(700, workAreaSize.height)
  const winWidth = Math.min(1500, Math.max(minWinWidth, workAreaSize.width - 80))
  const winHeight = Math.min(950, Math.max(minWinHeight, workAreaSize.height - 80))

  const win = new BrowserWindow({
    title: 'Ovolve',
    icon: isWin && typeof appIcon === 'string' ? appIcon : iconImg && !iconImg.isEmpty() ? iconImg : appIcon,
    width: winWidth,
    height: winHeight,
    minWidth: minWinWidth,
    minHeight: minWinHeight,
    center: true,
    show: false,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: '#090A0F',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
    },
  })

  if (isWin) {
    try {
      if (typeof appIcon === 'string') win.setIcon(appIcon)
      else if (iconImg && !iconImg.isEmpty()) win.setIcon(iconImg)
    } catch (_) {}
  }

  if (isPrimary) mainWindow = win
  appWindows.add(win)

  if (isPrimary) {
    win.on('close', (e) => {
      if (getIsQuitting()) return
      if (!getCloseToTray()) return
      const otherLive = [...appWindows].some((w) => w !== win && !w.isDestroyed())
      if (otherLive) return
      e.preventDefault()
      win.hide()
    })
  }

  const isDev = !app.isPackaged || Boolean(process.env.VITE_DEV_SERVER_URL)

  win.webContents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase()

    if ((input.meta || input.control) && key === 'n' && !input.shift && !input.alt) {
      win.webContents.send('app:new-session')
      event.preventDefault()
      return
    }

    // DevTools: F12 / Ctrl+Shift+I — always available (dev + production)
    if (key === 'f12' || ((input.meta || input.control) && input.shift && key === 'i')) {
      win.webContents.toggleDevTools()
      event.preventDefault()
      return
    }

    if (isDev) {
      if (key === 'f5' || ((input.meta || input.control) && key === 'r')) {
        if (input.shift || input.control) win.webContents.reloadIgnoringCache()
        else win.webContents.reload()
        event.preventDefault()
        return
      }
    }
  })

  const forceShow = () => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show()
      win.focus()
    }
  }
  win.once('ready-to-show', forceShow)
  win.webContents.once('did-finish-load', () => setTimeout(forceShow, 200))
  setTimeout(forceShow, 3000)

  const emitState = () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:state', { maximized: win.isMaximized() })
  }
  win.on('maximize', emitState)
  win.on('unmaximize', emitState)

  const devServerUrl = process.env.VITE_DEV_SERVER_URL || (isDev ? 'http://localhost:5173' : undefined)
  const wsQuery = opts.workspace ? { workspace: opts.workspace } : undefined

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const proto = new URL(url).protocol
      if (proto === 'http:' || proto === 'https:') shell.openExternal(url)
    } catch {}
    return { action: 'deny' }
  })

  if (isDev && devServerUrl) {
    const suffix = opts.workspace ? `?workspace=${encodeURIComponent(opts.workspace)}` : ''
    win.loadURL(`${devServerUrl}${suffix}`)
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'), wsQuery ? { query: wsQuery } : undefined)
  }

  win.on('closed', () => {
    appWindows.delete(win)
    if (mainWindow === win) {
      const next = [...appWindows].find((w) => !w.isDestroyed())
      mainWindow = next ?? null
    }
  })

  return win
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    const userDataDir = app.getPath('userData')
    const configRoot = path.join(userDataDir, 'ovolve_agent')
    try {
      fs.mkdirSync(configRoot, { recursive: true })
    } catch (_) {}

    initPathScope(configRoot)
    registerAllIpc({
      getMainWindow: () => mainWindow,
      configRoot,
      openWorkspaceWindow: (workspacePath: string) => createWindow({ workspace: workspacePath }),
    })

    const scriptPath = findPythonScript()
    if (scriptPath) {
      pythonProcess = startPythonBackend(scriptPath)
    } else {
      console.warn('[electron] app/main.py not found — running without Python backend')
    }

    await waitForBackendReady()
    const identity = await verifyBackendIdentity()
    if (identity === 'foreign') {
      console.error('[electron] Port 8765 is held by a foreign backend with mismatched API token')
    }

    createWindow()

    createTray({
      getMainWindow: () => mainWindow,
      sendToMain: (channel, payload) => {
        try {
          mainWindow?.webContents.send(channel, payload)
        } catch (_) {}
      },
      quit: () => {
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
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    setIsQuitting(true)
    destroyTray()
    cleanupBackend()
  })
}
