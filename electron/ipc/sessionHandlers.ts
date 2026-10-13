import { ipcMain } from 'electron'
import type { IPCContext } from './index'
import { SessionStore } from '../services/sessionStore'

export function registerSessionHandlers(ctx: IPCContext) {
  const store = new SessionStore(ctx.configRoot)

  ipcMain.handle('session:load', () => store.load())

  ipcMain.handle('session:save', (_e, data: { sessions: any[]; activeSessionId: string | null }) => {
    store.save(data.sessions, data.activeSessionId)
    return { ok: true }
  })
}
