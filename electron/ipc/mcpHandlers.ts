import { ipcMain } from 'electron'
import type { IPCContext } from './index'
import { getMcpManager } from '../services/mcpService'

export function registerMcpHandlers(_ctx: IPCContext) {
  const mgr = getMcpManager()

  ipcMain.handle('mcp:listServers', () => mgr.listServers())
  ipcMain.handle('mcp:addServer', async (_e, config: any) => {
    mgr.addServer(config)
    await mgr.connectAll()
    return { ok: true }
  })
  ipcMain.handle('mcp:listTools', () => mgr.listTools())
  ipcMain.handle('mcp:callTool', async (_e, serverId: string, toolName: string, args: any) => {
    return mgr.callTool(serverId, toolName, args)
  })
  ipcMain.handle('mcp:connectAll', async () => {
    await mgr.connectAll()
    return { ok: true, tools: mgr.listTools().length }
  })
}
