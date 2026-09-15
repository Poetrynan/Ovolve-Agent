import { ipcMain, BrowserWindow } from 'electron'
import type { IPCContext } from './index'
import { getEvolutionService } from '../services/evolutionService'

export function registerEvolutionHandlers(ctx: IPCContext) {
  const getSvc = (workspaceRoot?: string) => getEvolutionService(ctx.configRoot, workspaceRoot || process.cwd())

  ipcMain.handle('evolution:mode', (_e, workspaceRoot?: string) => ({ mode: getSvc(workspaceRoot).getMode() }))
  ipcMain.handle('evolution:setMode', (_e, mode: string, workspaceRoot?: string) => {
    getSvc(workspaceRoot).setMode(mode as any)
    return { ok: true }
  })
  ipcMain.handle('evolution:proposals', (_e, workspaceRoot?: string) => getSvc(workspaceRoot).openProposals())
  ipcMain.handle('evolution:recordSignal', (_e, payload: any, workspaceRoot?: string) => {
    const sig = getSvc(workspaceRoot).recordSignal(payload.kind, payload.toolName, payload.detail, payload.sessionId)
    const created = getSvc(workspaceRoot).mine()
    if (created.length) {
      const win = BrowserWindow.getAllWindows()[0]
      win?.webContents.send('evolution:proposal', { openCount: getSvc(workspaceRoot).openProposals().length, created })
    }
    return { signature: sig, created }
  })
  ipcMain.handle('evolution:mine', (_e, workspaceRoot?: string) => getSvc(workspaceRoot).mine())
  ipcMain.handle('evolution:accept', (_e, id: string, workspaceRoot?: string) => getSvc(workspaceRoot).accept(id, workspaceRoot))
  ipcMain.handle('evolution:reject', (_e, id: string, workspaceRoot?: string) => getSvc(workspaceRoot).reject(id))
  ipcMain.handle('evolution:rulesPrompt', (_e, workspaceRoot?: string) => getSvc(workspaceRoot).getEvolvedRulesPrompt(workspaceRoot))
}
