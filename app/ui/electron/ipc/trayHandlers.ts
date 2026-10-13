// electron/ipc/trayHandlers.ts
// Bridge between the renderer's tray/close preferences and the main-process
// tray module.
//
// The close-to-tray decision has to be readable synchronously inside the
// window's `close` handler, which lives in the main process — so the renderer
// cannot be the source of truth at that moment. Instead the renderer owns the
// persisted value (localStorage, like every other UI pref) and pushes it here
// on mount and on every toggle. Main keeps it in memory; a fresh boot defaults
// to hide-on-close until the renderer says otherwise.
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

  /** Hide the window into the tray on demand (e.g. a "minimize to tray" menu item). */
  ipcMain.handle('tray:hideWindow', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? ctx.getMainWindow()
    win?.hide()
    return { ok: true }
  })

  /**
   * Real quit from the renderer — used by an in-app "Quit" affordance so it
   * behaves identically to the tray menu item rather than merely hiding.
   */
  ipcMain.handle('tray:quit', async () => {
    setIsQuitting(true)
    app.quit()
    return { ok: true }
  })
}
