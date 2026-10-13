// electron/tray.ts
// System tray icon + context menu for OvolveAgent.
import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import path from 'path'
import fs from 'fs'

let tray: Tray | null = null
let isQuitting = false
let closeToTray = true

export function getIsQuitting(): boolean { return isQuitting }
export function setIsQuitting(v: boolean): void { isQuitting = v }
export function getCloseToTray(): boolean { return closeToTray }
export function setCloseToTray(v: boolean): void { closeToTray = v }

function resolveTrayIcon(): Electron.NativeImage {
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
      try {
        const img = nativeImage.createFromPath(c)
        if (!img.isEmpty()) return img
      } catch (_) {}
    }
  }
  return nativeImage.createEmpty()
}

function showWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

export interface CreateTrayCtx {
  getMainWindow: () => BrowserWindow | null
  sendToMain: (channel: string, payload?: any) => void
  quit: () => void
}

export function createTray(ctx: CreateTrayCtx): Tray {
  destroyTray()

  const t = new Tray(resolveTrayIcon())
  t.setToolTip('OvolveAgent')

  const rebuildMenu = () => {
    const win = ctx.getMainWindow()
    const isVisible = !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized())

    const menu = Menu.buildFromTemplate([
      {
        label: isVisible ? 'Hide OvolveAgent' : 'Open OvolveAgent',
        click: () => {
          const w = ctx.getMainWindow()
          if (!w) return
          if (isVisible) w.hide()
          else showWindow(w)
        },
      },
      { type: 'separator' },
      {
        label: 'New Chat',
        click: () => {
          const w = ctx.getMainWindow()
          showWindow(w)
          ctx.sendToMain('app:new-session')
        },
      },
      {
        label: 'Settings',
        click: () => {
          const w = ctx.getMainWindow()
          showWindow(w)
          ctx.sendToMain('app:open-settings')
        },
      },
      { type: 'separator' },
      {
        label: 'Quit OvolveAgent',
        click: () => ctx.quit(),
      },
    ])
    t.setContextMenu(menu)
  }

  rebuildMenu()

  if (process.platform !== 'darwin') {
    t.on('click', () => {
      const w = ctx.getMainWindow()
      if (!w) return
      if (w.isVisible() && !w.isMinimized()) w.hide()
      else showWindow(w)
      rebuildMenu()
    })
  }

  const win = ctx.getMainWindow()
  if (win) {
    win.on('show', rebuildMenu)
    win.on('hide', rebuildMenu)
    win.on('minimize', rebuildMenu)
    win.on('restore', rebuildMenu)
  }

  tray = t
  return t
}

export function destroyTray(): void {
  if (tray) {
    try { tray.destroy() } catch (_) {}
    tray = null
  }
}
