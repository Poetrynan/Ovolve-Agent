// electron/ipc/trayHandlers.ts
// Bridge between renderer's tray/close preferences and main process tray module.
import { BrowserWindow, ipcMain, app } from 'electron'
import type { IPCContext } from './index'
import { getCloseToTray, setCloseToTray, setIsQuitting } from '../tray'

export function registerTrayHandlers(ctx: IPCContext) {
  ipcMain.handle('tray:setCloseToTray', async (_e, value: boolean) => {
    setCloseToTray(value !== false)
    return { ok: true, closeToTray: getCloseToTray() }
  })

  ipcMain.handle('tray:getCloseToTray', async () => ({
    ok: true,
    closeToTray: getCloseToTray(),
  }))

  ipcMain.handle('tray:hideWindow', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? ctx.getMainWindow()
    win?.hide()
    return { ok: true }
  })

  ipcMain.handle('tray:quit', async () => {
    setIsQuitting(true)
    app.quit()
    return { ok: true }
  })
}
