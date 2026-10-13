import { ipcMain } from 'electron'
import type { IPCContext } from './index'
import { getMemoryService } from '../services/memoryService'

export function registerMemoryHandlers(ctx: IPCContext) {
  const svc = () => getMemoryService(ctx.configRoot)

  ipcMain.handle('memory:store', (_e, rootDir: string, entry: any) => svc().store(rootDir, entry))
  ipcMain.handle('memory:list', (_e, rootDir: string, tier?: string) => svc().list(rootDir, tier as any))
  ipcMain.handle('memory:recall', (_e, rootDir: string, query: string, topK?: number) => svc().recall(rootDir, query, topK))
  ipcMain.handle('memory:inject', (_e, rootDir: string, sessionId: string) => svc().buildInjection(rootDir, sessionId))
  ipcMain.handle('memory:dream', async (_e, rootDir: string) => svc().dreamConsolidate(rootDir))
  ipcMain.handle('memory:diagnostics', (_e, rootDir: string) => svc().diagnostics(rootDir))
  ipcMain.handle('memory:flushCompaction', (_e, rootDir: string, sessionId: string, messages: any[]) =>
    svc().flushForCompaction(rootDir, sessionId, messages)
  )
  ipcMain.handle('memory:touch', () => { svc().touch(); return { ok: true } })
}
