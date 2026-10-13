// electron/tray.ts
// System tray icon + context menu — the piece that makes Ovolve behave like a
// real desktop app (Slack, Discord) instead of a browser tab.
//
// Why a tray at all: Ovolve is an *agent* — turns can run for minutes and
// bots/schedulers keep firing while the window is closed. If clicking the X
// really quit the process, the user would silently kill work in flight every
// time they closed the window. The tray gives us a hidden-but-alive state so
// closing the window means "get out of my way", not "kill everything".
//
// Design notes:
//   - Windows/Linux: left-click toggles window visibility, right-click opens
//     the context menu. This matches Slack, Discord, Zoom, etc.
//   - macOS: click always shows the menu (Apple HIG); we still expose the
//     module so `main.ts` can import unconditionally.
//   - The tray owns two pieces of shared state: `isQuitting` (are we in a real
//     quit sequence, so the close-handler should let close through) and
//     `closeToTray` (does the user want X to hide instead of quit). Both are
//     exposed via getters/setters so main.ts and the IPC layer stay in sync.
import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import path from 'path'
import fs from 'fs'

let tray: Tray | null = null
let isQuitting = false
// Default: hide to tray on close. This is the safer default for an agent app:
// user-facing "close" should never silently terminate an in-flight run. The
// only way to actually quit is the tray "Quit Ovolve" item or the OS-level
// signal chain, both of which set `isQuitting` first.
let closeToTray = true

export function getIsQuitting(): boolean { return isQuitting }
export function setIsQuitting(v: boolean): void { isQuitting = v }
export function getCloseToTray(): boolean { return closeToTray }
export function setCloseToTray(v: boolean): void { closeToTray = v }

/**
 * Locate a small icon suitable for the system tray. On Windows the tray uses a
 * 16×16 / 32×32 slot, so a `.ico` (multi-resolution) is preferable to a PNG.
 * We mirror the resolution logic used by `getAppIcon()` in main.ts but return
 * an empty nativeImage as a last resort so `new Tray(...)` never throws — a
 * missing icon just shows the OS placeholder.
 */
function resolveTrayIcon(): Electron.NativeImage {
  const isDev = !app.isPackaged || Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.OVOLVE_DEV_MODE === '1'
  const isWin = process.platform === 'win32'

  const candidates: string[] = []
  if (isDev) {
    if (isWin) {
      candidates.push(
        path.resolve(__dirname, 'icon.ico'),
        path.resolve(__dirname, '../public/icon.ico'),
        path.resolve(process.cwd(), 'public/icon.ico'),
        path.resolve(process.cwd(), 'app/ui/public/icon.ico'),
        path.resolve(app.getAppPath(), 'public/icon.ico'),
        path.resolve(app.getAppPath(), '../public/icon.ico'),
      )
    }
    candidates.push(
      path.resolve(__dirname, 'icon.png'),
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
      try {
        const img = nativeImage.createFromPath(c)
        if (!img.isEmpty()) return img
      } catch (_) { /* try next candidate */ }
    }
  }
  return nativeImage.createEmpty()
}

/**
 * Show + focus the main window, restoring first if minimized or hidden.
 * Also nudges the taskbar entry back into a normal state so the tray is not
 * the only route back into the app.
 */
function showWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

export interface CreateTrayCtx {
  /** Reader for the primary window — same signature as IPCContext. */
  getMainWindow: () => BrowserWindow | null
  /** Bump into the renderer of the primary window (best-effort). */
  sendToMain: (channel: string, payload?: any) => void
  /** Kick off the "real quit" sequence — sets isQuitting then calls app.quit(). */
  quit: () => void
}

/**
 * Build the tray icon and its context menu. Idempotent — safe to call twice;
 * a second call replaces the previous tray.
 */
export function createTray(ctx: CreateTrayCtx): Tray {
  destroyTray()

  const t = new Tray(resolveTrayIcon())
  t.setToolTip('Ovolve')

  const rebuildMenu = () => {
    const win = ctx.getMainWindow()
    const isVisible = !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized())

    const menu = Menu.buildFromTemplate([
      {
        // The primary affordance is different depending on state: when the
        // window is hidden, "Show" is what the user actually wants; when it is
        // already visible, offering "Hide" lets them get out of the way
        // without touching the mouse cursor.
        label: isVisible ? 'Hide Ovolve' : 'Open Ovolve',
        click: () => {
          const w = ctx.getMainWindow()
          if (!w) return
          if (isVisible) w.hide()
          else showWindow(w)
        },
      },
      { type: 'separator' },
      {
        label: 'New chat',
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
        label: 'Quit Ovolve',
        click: () => ctx.quit(),
      },
    ])
    t.setContextMenu(menu)
  }

  rebuildMenu()

  // Left-click toggles visibility on Windows/Linux. macOS convention is that
  // a tray/menu-bar item always opens the menu on click, so we skip the toggle
  // there and let the OS handle it via the context menu.
  if (process.platform !== 'darwin') {
    t.on('click', () => {
      const w = ctx.getMainWindow()
      if (!w) return
      if (w.isVisible() && !w.isMinimized()) w.hide()
      else showWindow(w)
      // Rebuild so the top menu item's label ("Open" vs "Hide") reflects the
      // new state without waiting for the user to reopen the context menu.
      rebuildMenu()
    })
  }

  // Refresh the menu when the window visibility changes from anywhere else
  // (a Settings toggle, an IPC call, the user pressing Ctrl+H, etc.). Without
  // this, a menu that was built while the window was hidden would keep
  // saying "Open Ovolve" even after the window is on-screen.
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
    try { tray.destroy() } catch (_) { /* already gone */ }
    tray = null
  }
}
