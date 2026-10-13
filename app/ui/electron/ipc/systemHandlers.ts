// electron/ipc/systemHandlers.ts
// System info + safe shell escapes + native notifications.
import { ipcMain, shell, app, Notification, BrowserWindow } from 'electron'
import os from 'os'
import path from 'path'
import fs from 'fs'
import type { IPCContext } from './index'

export function registerSystemHandlers(ctx: IPCContext) {
  ipcMain.handle('system:info', async () => ({
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    hostname: os.hostname(),
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    appVersion: app.getVersion(),
    appName: app.getName(),
    userDataPath: app.getPath('userData'),
    homePath: app.getPath('home'),
    tempPath: app.getPath('temp'),
  }))

  ipcMain.handle('system:openExternal', async (_e, url: string) => {
    // Only allow http(s) and mailto — never file:// from the renderer.
    if (!/^(https?:|mailto:)/i.test(url)) {
      return { ok: false, error: `blocked scheme: ${url}` }
    }
    await shell.openExternal(url)
    return { ok: true }
  })

  ipcMain.handle('system:showInFolder', async (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
    return { ok: true }
  })

  ipcMain.handle('system:openPath', async (_e, filePath: string) => {
    const err = await shell.openPath(filePath)
    return { ok: !err, error: err || undefined }
  })

  // ─── Native OS notification (Windows toast, macOS banner, Linux libnotify) ───
  // The renderer calls this instead of the web Notification API so:
  //  1. The toast carries the app icon and correct AppUserModelId (taskbar grouping)
  //  2. Click navigates to the specific session in the window
  //  3. Works even when the renderer doesn't have notification permission
  ipcMain.handle(
    'system:notify',
    async (e, opts: { title: string; body: string; sessionId?: string }) => {
      if (!Notification.isSupported()) return { ok: false, error: 'not supported' }

      const notif = new Notification({
        title: opts.title,
        body: opts.body,
        // Electron resolves relative icon against the app root; for dev the PNG
        // may not exist yet — failing silently is fine, Windows uses the .exe icon.
        icon: getNotifIcon(),
      })

      notif.on('click', () => {
        // Focus the window that sent the invoke; fall back to main.
        const win = BrowserWindow.fromWebContents(e.sender) ?? ctx.getMainWindow()
        if (win) {
          if (win.isMinimized()) win.restore()
          win.focus()
        }
        // Tell the renderer to switch to this session (it will listen on
        // the event channel 'app:notify-click').
        if (opts.sessionId) {
          e.sender.send('app:notify-click', { sessionId: opts.sessionId })
        }
      })

      notif.show()
      return { ok: true }
    },
  )
}

/** Best-effort app icon path for the notification. */
function getNotifIcon(): string | undefined {
  try {
    // In production the icon is next to the asar; in dev it's in public/.
    const candidates = [
      path.join(app.getAppPath(), 'build', 'icon.png'),
      path.join(app.getAppPath(), '..', 'build', 'icon.png'),
      path.join(app.getAppPath(), 'public', 'icon.png'),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
  } catch { /* no icon is non-fatal */ }
  return undefined
}
