// electron/ipc/settingsHandlers.ts
// Persist renderer settings under configRoot/setting.json.
import { ipcMain } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import type { IPCContext } from './index'

async function loadSettings(root: string): Promise<Record<string, any>> {
  const file = path.join(root, 'setting.json')
  if (!fsSync.existsSync(file)) return {}
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'))
  } catch (e) {
    console.warn('[settings] parse failed, resetting:', e)
    return {}
  }
}

async function saveSettings(root: string, obj: Record<string, any>) {
  await fs.mkdir(root, { recursive: true })
  const file = path.join(root, 'setting.json')
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf-8')
}

export function registerSettingsHandlers(ctx: IPCContext) {
  ipcMain.handle('settings:getAll', async () => loadSettings(ctx.configRoot))

  ipcMain.handle('settings:get', async (_e, key: string) => {
    const all = await loadSettings(ctx.configRoot)
    return all[key]
  })

  ipcMain.handle('settings:set', async (_e, key: string, value: any) => {
    const all = await loadSettings(ctx.configRoot)
    all[key] = value
    await saveSettings(ctx.configRoot, all)
    return { ok: true }
  })

  ipcMain.handle('settings:merge', async (_e, patch: Record<string, any>) => {
    const all = await loadSettings(ctx.configRoot)
    const next = { ...all, ...patch }
    await saveSettings(ctx.configRoot, next)
    return { ok: true, settings: next }
  })
}
