// electron/ipc/systemHandlers.ts
// System info + shell escapes + native notifications.
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

  ipcMain.handle(
    'system:notify',
    async (e, opts: { title: string; body: string; sessionId?: string }) => {
      if (!Notification.isSupported()) return { ok: false, error: 'not supported' }

      const notif = new Notification({
        title: opts.title,
        body: opts.body,
        icon: getNotifIcon(),
      })

      notif.on('click', () => {
        const win = BrowserWindow.fromWebContents(e.sender) ?? ctx.getMainWindow()
        if (win) {
          if (win.isMinimized()) win.restore()
          win.focus()
        }
        if (opts.sessionId) {
          e.sender.send('app:notify-click', { sessionId: opts.sessionId })
        }
      })

      notif.show()
      return { ok: true }
    },
  )
}

function getNotifIcon(): string | undefined {
  try {
    const candidates = [
      path.join(app.getAppPath(), 'public', 'icon.png'),
      path.resolve(process.cwd(), 'public', 'icon.png'),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
  } catch {}
  return undefined
}
