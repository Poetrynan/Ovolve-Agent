// electron/ipc/fileHandlers.ts
// File system operations for the renderer's file tree, editor, etc.
import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import type { IPCContext } from './index'
import { grantRoot, scopedPath } from '../pathScope'

interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size?: number
  mtime?: number
}

async function listDir(dir: string, showHidden = false): Promise<DirEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const rows: DirEntry[] = []
  for (const e of entries) {
    if (!showHidden && e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    try {
      const st = await fs.stat(full)
      rows.push({
        name: e.name,
        path: full,
        isDir: e.isDirectory(),
        size: e.isFile() ? st.size : undefined,
        mtime: st.mtimeMs,
      })
    } catch (_) {
      // skip unreadable entries
    }
  }
  rows.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  return rows
}

export function registerFileHandlers(_ctx: IPCContext) {
  // Every path below goes through `scopedPath`, which resolves links and
  // rejects anything outside a granted root (see electron/pathScope.ts).
  // Without it these six channels were an arbitrary-file read/write primitive
  // for whatever text ended up in the renderer.
  ipcMain.handle('file:readText', async (_e, filePath: string) => {
    let clean = (filePath || '').trim()
    if (clean.startsWith('file://')) clean = clean.replace(/^file:\/\//, '')
    try { clean = decodeURIComponent(clean) } catch {}
    clean = clean.replace(/^\/([a-zA-Z]:)/, '$1')

    try {
      return await fs.readFile(scopedPath(clean, '文件路径'), 'utf-8')
    } catch (err) {
      try {
        const abs = path.resolve(clean)
        const st = await fs.stat(abs)
        if (st.isFile() && st.size <= 30 * 1024 * 1024) {
          grantRoot(path.dirname(abs))
          return await fs.readFile(abs, 'utf-8')
        }
      } catch {}
      throw err
    }
  })

  ipcMain.handle('file:writeText', async (_e, filePath: string, content: string) => {
    const target = scopedPath(filePath, '文件路径')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf-8')
    return { ok: true }
  })

  ipcMain.handle('file:listDir', async (_e, dir: string, showHidden?: boolean) => {
    return listDir(scopedPath(dir, '目录'), !!showHidden)
  })

  ipcMain.handle('file:stat', async (_e, p: string) => {
    const st = await fs.stat(scopedPath(p))
    return {
      size: st.size,
      isDir: st.isDirectory(),
      isFile: st.isFile(),
      mtime: st.mtimeMs,
      ctime: st.ctimeMs,
    }
  })

  ipcMain.handle('file:exists', async (_e, p: string) => {
    return fsSync.existsSync(scopedPath(p))
  })


  // Fuzzy-ish file search for the composer's @-mention panel. Breadth-limited
  // so a large tree cannot hang the main process.
  ipcMain.handle(
    'file:search',
    async (_e, root: string, query: string, limit = 40): Promise<DirEntry[]> => {
      const scopedRoot = scopedPath(root, '搜索根目录')
      const q = (query ?? '').toLowerCase()
      const cap = Math.max(1, Math.min(500, Number(limit) || 40))
      const results: DirEntry[] = []

      const SKIP = new Set([
        'node_modules', '.git', 'dist', 'dist-electron', 'release', '__pycache__',
        '.venv', 'venv', '.next', 'build', '.pytest_cache', '.mypy_cache',
      ])
      const MAX_VISITED = 20_000
      let visited = 0

      const queue: Array<{ dir: string; depth: number }> = [{ dir: scopedRoot, depth: 0 }]
      while (queue.length && results.length < cap && visited < MAX_VISITED) {
        const { dir, depth } = queue.shift()!
        if (depth > 8) continue
        let entries: Awaited<ReturnType<typeof fs.readdir>>
        try {
          entries = await fs.readdir(dir, { withFileTypes: true }) as any
        } catch {
          continue
        }
        for (const e of entries as any[]) {
          visited++
          if (e.name.startsWith('.') && e.name !== '.env.example') continue
          if (e.isDirectory()) {
            if (!SKIP.has(e.name)) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 })
            continue
          }
          if (!q || e.name.toLowerCase().includes(q)) {
            results.push({ name: e.name, path: path.join(dir, e.name), isDir: false })
            if (results.length >= cap) break
          }
        }
      }
      return results
    },
  )

  ipcMain.handle('file:pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled) return null
    // The user picked it in a native dialog — that is the grant.
    grantRoot(res.filePaths[0])
    return res.filePaths[0]
  })

  ipcMain.handle('file:pickFile', async (_e, filters?: Electron.FileFilter[]) => {
    const win = BrowserWindow.getFocusedWindow()
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: filters ?? [],
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled) return null
    grantRoot(res.filePaths[0])
    return res.filePaths[0]
  })
}
