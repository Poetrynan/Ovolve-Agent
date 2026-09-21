// electron/ipc/windowHandlers.ts
// Custom title-bar controls (min/max/close) + drag hooks.
//
// Every handler resolves the window from `event.sender` first: with multiple
// app windows open, "close" pressed in window B must close B, not the main
// window. `getMainWindow()` stays as the fallback for calls that arrive with no
// resolvable sender (e.g. a destroyed frame mid-teardown).
import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron'
import type { IPCContext } from './index'

export function registerWindowHandlers(ctx: IPCContext) {
  const senderWindow = (e: IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender) ?? ctx.getMainWindow()

  ipcMain.handle('window:minimize', async (e) => {
    senderWindow(e)?.minimize()
    return { ok: true }
  })

  ipcMain.handle('window:toggleMaximize', async (e) => {
    const w = senderWindow(e)
    if (!w) return { ok: false, error: 'no window' }
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    return { ok: true, maximized: w.isMaximized() }
  })

  ipcMain.handle('window:close', async (e) => {
    senderWindow(e)?.close()
    return { ok: true }
  })

  ipcMain.handle('window:isMaximized', async (e) => !!senderWindow(e)?.isMaximized())

  ipcMain.handle('window:setTitle', async (e, title: string) => {
    senderWindow(e)?.setTitle(title || 'Ovolve')
    return { ok: true }
  })

  ipcMain.handle('window:reload', async (e) => {
    senderWindow(e)?.webContents.reload()
    return { ok: true }
  })

  ipcMain.handle('window:openDevTools', async (e) => {
    senderWindow(e)?.webContents.openDevTools({ mode: 'detach' })
    return { ok: true }
  })
}
