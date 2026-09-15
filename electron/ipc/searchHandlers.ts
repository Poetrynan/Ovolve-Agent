import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { IPCContext } from './index'
import { scopedPath } from '../pathScope'

export function registerSearchHandlers(_ctx: IPCContext) {
  ipcMain.handle('search:grep', async (_e, root: string, pattern: string, glob?: string) => {
    const scoped = scopedPath(root, '搜索根目录')
    return new Promise((resolve) => {
      const args = ['--json', '-e', pattern, scoped]
      if (glob) args.push('--glob', glob)

      // Try ripgrep first, fallback to git grep
      const proc = spawn('rg', args, { shell: true })
      let stdout = ''
      proc.stdout.on('data', (d) => { stdout += d })
      proc.on('close', (code) => {
        if (code === 0 && stdout) {
          const lines = stdout.trim().split('\n').slice(0, 100)
          const results = lines.map((l) => {
            try {
              const j = JSON.parse(l)
              if (j.type === 'match') {
                return { file: j.data.path.text, line: j.data.line_number, text: j.data.lines.text.trim() }
              }
            } catch {}
            return null
          }).filter(Boolean)
          resolve(results)
          return
        }

        // Fallback: simple file scan
        const results: Array<{ file: string; line: number; text: string }> = []
        const scan = (dir: string, depth = 0) => {
          if (depth > 6 || results.length > 100) return
          try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
              const full = path.join(dir, entry.name)
              if (entry.isDirectory()) scan(full, depth + 1)
              else if (entry.isFile()) {
                try {
                  const content = fs.readFileSync(full, 'utf-8')
                  const lines = content.split('\n')
                  for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(pattern)) {
                      results.push({ file: full, line: i + 1, text: lines[i].trim() })
                      if (results.length >= 100) return
                    }
                  }
                } catch {}
              }
            }
          } catch {}
        }
        scan(scoped)
        resolve(results)
      })
      proc.on('error', () => resolve([]))
    })
  })

  ipcMain.handle('search:glob', async (_e, root: string, pattern: string) => {
    const scoped = scopedPath(root, '搜索根目录')
    const results: string[] = []
    const regex = new RegExp('^' + pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$')

    const scan = (dir: string, rel = '', depth = 0) => {
      if (depth > 8 || results.length > 200) return
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') && entry.name !== '.env') continue
          const relPath = rel ? `${rel}/${entry.name}` : entry.name
          if (entry.isDirectory() && !['node_modules', 'dist', '.git'].includes(entry.name)) {
            scan(path.join(dir, entry.name), relPath, depth + 1)
          } else if (entry.isFile() && regex.test(relPath.replace(/\\/g, '/'))) {
            results.push(path.join(dir, entry.name))
          }
        }
      } catch {}
    }
    scan(scoped)
    return results
  })
}
