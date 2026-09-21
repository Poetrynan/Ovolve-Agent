// electron/ipc/terminalHandlers.ts
// Interactive PTY terminals (user panel) + one-shot shell execution.
//
// Mirrors common IDE terminal hosts: node-pty in the main process, xterm in the
// renderer, path-scoped cwd. Falls back to piped spawn when PTY is unavailable.
import { ipcMain, type BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import os from 'os'
import { randomUUID } from 'crypto'
import type { IPCContext } from './index'
import { grantWorkspacePaths, resolveTerminalCwd, scopedPath } from '../pathScope'

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

type PtyModule = typeof import('node-pty')

interface TerminalSession {
  id: string
  cwd: string
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
}

const sessions = new Map<string, TerminalSession>()
let ptyModule: PtyModule | null | undefined

function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) return ptyModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('node-pty') as PtyModule
  } catch {
    ptyModule = null
    console.warn('[terminal] node-pty unavailable — using piped shell fallback')
  }
  return ptyModule
}

function shellSpec(cwd: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'],
    }
  }
  const shell = process.env.SHELL || '/bin/bash'
  return { file: shell, args: ['-l'] }
}

function broadcast(windows: Iterable<BrowserWindow>, channel: string, payload: unknown) {
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

function allWindows(ctx: IPCContext): BrowserWindow[] {
  const main = ctx.getMainWindow()
  const out: BrowserWindow[] = []
  if (main && !main.isDestroyed()) out.push(main)
  return out
}

function attachDataPump(
  ctx: IPCContext,
  sessionId: string,
  onData: (cb: (data: string) => void) => void,
) {
  onData((data) => {
    broadcast(allWindows(ctx), 'terminal:data', { sessionId, data })
  })
}

function createSession(ctx: IPCContext, sessionId: string, cwd: string): TerminalSession {
  const pty = loadPty()
  const spec = shellSpec(cwd)

  if (pty) {
    const term = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    attachDataPump(ctx, sessionId, (cb) => term.onData(cb))
    return {
      id: sessionId,
      cwd,
      write: (data) => term.write(data),
      resize: (cols, rows) => {
        try { term.resize(cols, rows) } catch { /* ignore */ }
      },
      kill: () => {
        try { term.kill() } catch { /* ignore */ }
      },
    }
  }

  // Fallback: piped shell (no true TTY, but usable for most CLI work).
  const proc = spawn(spec.file, spec.args, {
    cwd,
    env: { ...process.env, TERM: 'dumb', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams

  const pump = (buf: Buffer) => {
    broadcast(allWindows(ctx), 'terminal:data', {
      sessionId,
      data: buf.toString('utf8'),
    })
  }
  proc.stdout.on('data', pump)
  proc.stderr.on('data', pump)

  return {
    id: sessionId,
    cwd,
    write: (data) => {
      try { proc.stdin.write(data) } catch { /* ignore */ }
    },
    resize: () => { /* no-op for piped mode */ },
    kill: () => {
      try {
        if (process.platform === 'win32' && proc.pid) {
          spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)])
        } else {
          proc.kill('SIGTERM')
        }
      } catch { /* ignore */ }
    },
  }
}

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
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      resolve({ ok: false, stdout, stderr: stderr || 'timeout', code: -1 })
    }, timeoutMs)

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (d: string) => { stdout += d })
    proc.stderr.on('data', (d: string) => { stderr += d })
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

export function registerTerminalHandlers(ctx: IPCContext) {
  ipcMain.handle('terminal:create', async (_e, cwd: string, sessionId?: string) => {
    try {
      if (typeof cwd === 'string' && cwd.trim()) {
        grantWorkspacePaths([cwd])
      }
      const safeCwd = resolveTerminalCwd(cwd, '工作目录')
      const id = String(sessionId || randomUUID())
      sessions.get(id)?.kill()
      const sess = createSession(ctx, id, safeCwd)
      sessions.set(id, sess)
      return { ok: true, sessionId: id, cwd: safeCwd, pty: loadPty() !== null }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('terminal:write', async (_e, sessionId: string, data: string) => {
    const sess = sessions.get(String(sessionId || ''))
    if (!sess) return { ok: false, error: 'session not found' }
    sess.write(String(data ?? ''))
    return { ok: true }
  })

  ipcMain.handle('terminal:resize', async (_e, sessionId: string, cols: number, rows: number) => {
    const sess = sessions.get(String(sessionId || ''))
    if (!sess) return { ok: false, error: 'session not found' }
    sess.resize(Math.max(2, cols | 0), Math.max(1, rows | 0))
    return { ok: true }
  })

  ipcMain.handle('terminal:destroy', async (_e, sessionId: string) => {
    const id = String(sessionId || '')
    const sess = sessions.get(id)
    if (sess) {
      sess.kill()
      sessions.delete(id)
    }
    return { ok: true }
  })

  /** Echo an agent command + optional output into the user's terminal panel. */
  ipcMain.handle(
    'terminal:mirror',
    async (_e, sessionId: string, payload: { command?: string; chunk?: string; cwd?: string }) => {
      const id = String(sessionId || '')
      let sess = sessions.get(id)
      if (!sess && payload.cwd) {
        try {
          grantWorkspacePaths([payload.cwd])
          const safeCwd = scopedPath(payload.cwd, '工作目录')
          sess = createSession(ctx, id, safeCwd)
          sessions.set(id, sess)
        } catch {
          return { ok: false }
        }
      }
      if (!sess) return { ok: false, error: 'session not found' }
      if (payload.command) {
        const prompt = process.platform === 'win32' ? 'PS> ' : '$ '
        sess.write(`\r\n\x1b[90m# [Agent] ${payload.command}\x1b[0m\r\n${prompt}`)
      }
      if (payload.chunk) sess.write(String(payload.chunk))
      return { ok: true }
    },
  )

  ipcMain.handle(
    'terminal:run',
    async (_e, cwd: string, command: string, timeoutMs = 60_000) => {
      let safeCwd: string
      try {
        if (typeof cwd === 'string' && cwd.trim()) {
          grantWorkspacePaths([cwd])
        }
        safeCwd = resolveTerminalCwd(cwd, '工作目录')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, stdout: '', stderr: msg, code: -1 }
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
