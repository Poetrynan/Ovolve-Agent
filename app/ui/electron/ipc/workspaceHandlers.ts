// electron/ipc/workspaceHandlers.ts
// Workspace IPC: open new window, add folder to workspace (multi-root).
import { ipcMain } from 'electron'
import type { IPCContext } from './index'
import { grantRoot } from '../pathScope'

export function registerWorkspaceHandlers(ctx: IPCContext) {
  ipcMain.handle('workspace:openNewWindow', async (_e, workspacePath: string) => {
    if (!workspacePath) return { ok: false, error: 'workspace path required' }
    if (!ctx.openWorkspaceWindow) return { ok: false, error: 'multi-window unavailable' }
    try {
      ctx.openWorkspaceWindow(workspacePath)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('workspace:addFolder', async () => {
    // Opens a native folder picker, returns the chosen path so the renderer
    // can fire `workspace_switch` over WS. Does NOT switch automatically —
    // multi-root is a UI concept where several folders are listed, each
    // independently switchable.
    const { dialog } = await import('electron')
    const win = ctx.getMainWindow()
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: 'Add Folder to Workspace',
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths.length) {
      return { ok: false, canceled: true }
    }
    // A folder the user chose in a native dialog is the one unambiguous
    // signal of intent we get, so it becomes a granted root for the file:*
    // channels (see electron/pathScope.ts).
    grantRoot(result.filePaths[0])
    return { ok: true, path: result.filePaths[0] }
  })

  ipcMain.handle('workspace:grant', async (_e, paths: string | string[]) => {
    if (!paths) return { ok: false, error: 'path required' }
    const targets = Array.isArray(paths) ? paths : [paths]
    for (const t of targets) {
      if (typeof t === 'string' && t.trim()) {
        try {
          grantRoot(t.trim())
        } catch (_) {}
      }
    }
    return { ok: true }
  })

  ipcMain.handle('workspace:revealInExplorer', async (_e, workspacePath: string) => {
    if (!workspacePath) return { ok: false, error: 'path required' }
    const { shell } = await import('electron')
    try {
      await shell.openPath(workspacePath)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })
}
