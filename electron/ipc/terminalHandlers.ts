// electron/ipc/terminalHandlers.ts
// One-shot shell execution scoped to granted workspace roots.
import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import os from 'os'
import type { IPCContext } from './index'
import { scopedPath } from '../pathScope'

const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/f\s+\/s\b/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bgit\s+push\s+(-f|--force)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fdx\b/i,
  /\bdrop\s+(table|database)\b/i,
]

function runOnce(cwd: string, command: string, timeoutMs: number): Promise<{
  ok: boolean
  stdout: string
  stderr: string
  code: number
}> {
  const isWin = os.platform() === 'win32'
  const shell = isWin ? 'powershell.exe' : '/bin/bash'
  const shellArgs = isWin
    ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]
    : ['-lc', command]

  return new Promise((resolve) => {
    const proc = spawn(shell, shellArgs, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM')
      } catch (_) {}
      resolve({ ok: false, stdout, stderr: stderr || 'timeout', code: -1 })
    }, timeoutMs)

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (d: string) => (stdout += d))
    proc.stderr.on('data', (d: string) => (stderr += d))
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr, code: code ?? -1 })
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: err.message, code: -1 })
    })
  })
}

export function registerTerminalHandlers(_ctx: IPCContext) {
  ipcMain.handle(
    'terminal:run',
    async (_e, cwd: string, command: string, timeoutMs = 60_000) => {
      let safeCwd: string
      try {
        safeCwd = scopedPath(cwd, '工作目录')
      } catch (err: any) {
        return { ok: false, stdout: '', stderr: err?.message || String(err), code: -1 }
      }

      const cmd = String(command || '').trim()
      if (!cmd) {
        return { ok: false, stdout: '', stderr: 'empty command', code: -1 }
      }

      for (const pat of BLOCKED_PATTERNS) {
        if (pat.test(cmd)) {
          return { ok: false, stdout: '', stderr: 'command blocked by security policy', code: -1 }
        }
      }

      return runOnce(safeCwd, cmd, Math.min(timeoutMs, 120_000))
    },
  )
}
