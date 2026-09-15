/**
 * PersistentTerminal.ts — Persistent Shell Session with UUID Marker Protocol
 *
 * Responsibilities:
 * 1. Maintain a long-lived, stateful shell process per session (PowerShell on Windows, Bash on POSIX).
 * 2. Retain working directory (`cd`), environment variables, and virtual environment state across turns.
 * 3. Marker protocol anchoring (`__OVOLVE_START_{marker_id}__` and `__OVOLVE_END_{marker_id}__:$exit_code`)
 *    for exact output slice extraction and exit code parsing.
 * 4. Cross-platform timeout safety, command cancellation, and process tree termination.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export interface CommandResult {
  exitCode: number
  code: number // Backwards compatibility alias for exitCode
  output: string
  timedOut: boolean
  cancelled?: boolean
  error?: string
}

export interface TerminalExecutionOptions {
  timeoutMs?: number
  onLine?: (line: string) => void
}

export class PersistentTerminalSession {
  private sessionId: string
  private workspaceRoot: string
  private isWindows = os.platform() === 'win32'
  private proc: ChildProcess | null = null
  private stdoutBuffer = ''
  private isBusy = false
  private currentCancelHandler: (() => void) | null = null
  private executionQueue: Promise<any> = Promise.resolve()

  constructor(sessionId: string, workspaceRoot: string = '.') {
    this.sessionId = sessionId
    this.workspaceRoot = path.resolve(workspaceRoot || '.')
    this.startShell()
  }

  public getSessionId(): string {
    return this.sessionId
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot
  }

  public isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed
  }

  private startShell(): void {
    if (this.proc) {
      this.closeShell()
    }

    const cmd = this.isWindows ? 'powershell.exe' : '/bin/bash'
    const args = this.isWindows
      ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-']
      : ['--norc', '-i']

    try {
      this.proc = spawn(cmd, args, {
        cwd: this.workspaceRoot,
        env: {
          ...process.env,
          TERM: 'dumb',
          PAGER: 'cat',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      this.proc.stdout?.on('data', (data: Buffer) => {
        this.stdoutBuffer += data.toString('utf-8')
      })

      this.proc.stderr?.on('data', (data: Buffer) => {
        this.stdoutBuffer += data.toString('utf-8')
      })

      this.proc.on('exit', () => {
        this.proc = null
      })

      this.proc.on('error', (_err) => {
        this.proc = null
      })
    } catch {
      this.proc = null
    }
  }

  public closeShell(): void {
    if (this.proc) {
      const pid = this.proc.pid
      try {
        if (this.proc.stdin && !this.proc.stdin.destroyed) {
          this.proc.stdin.end()
        }
      } catch {}

      try {
        if (this.isWindows && pid) {
          spawn('taskkill', ['/T', '/F', '/PID', pid.toString()])
        } else if (pid) {
          this.proc.kill('SIGKILL')
        }
      } catch {}

      this.proc = null
    }
    this.isBusy = false
    this.currentCancelHandler = null
  }

  public close(): void {
    this.closeShell()
  }

  public cancelCurrentCommand(): void {
    if (this.currentCancelHandler) {
      this.currentCancelHandler()
    }
  }

  /**
   * Execute command in persistent shell session with UUID Marker Protocol
   */
  public async execute(
    command: string,
    optionsOrTimeout: number | TerminalExecutionOptions = 60000
  ): Promise<CommandResult> {
    const options: TerminalExecutionOptions =
      typeof optionsOrTimeout === 'number'
        ? { timeoutMs: optionsOrTimeout }
        : optionsOrTimeout

    const timeoutMs = options.timeoutMs ?? 60000
    const onLine = options.onLine

    // Chain onto queue to serialize command executions in the same session
    return (this.executionQueue = this.executionQueue
      .catch(() => {})
      .then(() => this._executeInternal(command, timeoutMs, onLine)))
  }

  private async _executeInternal(
    command: string,
    timeoutMs: number,
    onLine?: (line: string) => void
  ): Promise<CommandResult> {
    if (!this.isRunning()) {
      this.startShell()
    }

    if (!this.proc || !this.proc.stdin || !this.proc.stdout) {
      return {
        exitCode: -1,
        code: -1,
        output: 'Error: Shell process unavailable',
        timedOut: false,
        error: 'Failed to spawn shell process',
      }
    }

    this.isBusy = true
    this.stdoutBuffer = ''

    const markerId = crypto.randomBytes(6).toString('hex')
    const startMarker = `__OVOLVE_START_${markerId}__`
    const endMarkerPrefix = `__OVOLVE_END_${markerId}__`

    const wrappedScript = this.isWindows
      ? `Write-Output "${startMarker}"; ${command}; $__mb_exit = $LASTEXITCODE; if ($null -eq $__mb_exit) { if ($?) { $__mb_exit = 0 } else { $__mb_exit = 1 } }; Write-Output "${endMarkerPrefix}:$__mb_exit"\r\n`
      : `echo "${startMarker}"; ${command}; __mb_exit=$?; echo "${endMarkerPrefix}:$__mb_exit"\n`

    return new Promise<CommandResult>((resolve) => {
      let isResolved = false
      let streamedLineIndex = 0

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (checkInterval) clearInterval(checkInterval)
        this.currentCancelHandler = null
        this.isBusy = false
      }

      const timer = setTimeout(() => {
        if (isResolved) return
        isResolved = true
        cleanup()
        this.startShell() // Reset shell on timeout
        resolve({
          exitCode: -1,
          code: -1,
          output: this.stdoutBuffer ? `${this.stdoutBuffer}\n[Command timed out after ${timeoutMs / 1000}s (shell reset)]` : `[Command timed out after ${timeoutMs / 1000}s (shell reset)]`,
          timedOut: true,
          error: `Command timed out after ${timeoutMs / 1000}s`,
        })
      }, timeoutMs)

      this.currentCancelHandler = () => {
        if (isResolved) return
        isResolved = true
        cleanup()
        this.startShell() // Reset shell on cancel
        resolve({
          exitCode: -1,
          code: -1,
          output: this.stdoutBuffer ? `${this.stdoutBuffer}\n[Command cancelled by user (shell reset)]` : `[Command cancelled by user (shell reset)]`,
          timedOut: false,
          cancelled: true,
          error: 'Command cancelled by user',
        })
      }

      const checkInterval = setInterval(() => {
        const full = this.stdoutBuffer

        // Stream intermediate lines if callback provided
        if (onLine && full.includes(startMarker)) {
          const startIdx = full.indexOf(startMarker)
          const contentAfterStart = full.substring(startIdx + startMarker.length)
          const allLines = contentAfterStart.split(/\r?\n/)
          while (streamedLineIndex < allLines.length - 1) {
            const line = allLines[streamedLineIndex]
            if (!line.includes(endMarkerPrefix)) {
              onLine(line)
            }
            streamedLineIndex++
          }
        }

        if (full.includes(endMarkerPrefix)) {
          isResolved = true
          cleanup()

          const startIdx = full.indexOf(startMarker)
          const endIdx = full.indexOf(endMarkerPrefix)

          let extracted = ''
          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            extracted = full.substring(startIdx + startMarker.length, endIdx).trim()
          } else if (endIdx !== -1) {
            extracted = full.substring(0, endIdx).trim()
          } else {
            extracted = full.trim()
          }

          // Extract exit code: __OVOLVE_END_xxx__:0 or __OVOLVE_END_xxx__:_0
          const match = full.slice(endIdx).match(new RegExp(`${endMarkerPrefix}[:_](\\d+)`))
          const exitCode = match ? parseInt(match[1], 10) : 0

          resolve({
            exitCode,
            code: exitCode,
            output: extracted,
            timedOut: false,
          })
        }
      }, 25)

      try {
        this.proc!.stdin!.write(wrappedScript)
      } catch (e: any) {
        if (!isResolved) {
          isResolved = true
          cleanup()
          this.startShell()
          resolve({
            exitCode: -1,
            code: -1,
            output: `Failed to write command to shell: ${e.message}`,
            timedOut: false,
            error: e.message,
          })
        }
      }
    })
  }
}

// Provide PersistentShellSession as alias
export const PersistentShellSession = PersistentTerminalSession
export type PersistentShellSession = PersistentTerminalSession

export class PersistentTerminalManager {
  private static instance: PersistentTerminalManager
  private sessions = new Map<string, PersistentTerminalSession>()

  public static getInstance(): PersistentTerminalManager {
    if (!PersistentTerminalManager.instance) {
      PersistentTerminalManager.instance = new PersistentTerminalManager()
    }
    return PersistentTerminalManager.instance
  }

  public getOrCreate(sessionId: string, workspaceRoot?: string): PersistentTerminalSession {
    let session = this.sessions.get(sessionId)
    if (!session || !session.isRunning()) {
      session = new PersistentTerminalSession(sessionId, workspaceRoot)
      this.sessions.set(sessionId, session)
    }
    return session
  }

  public getSession(sessionId: string, workspaceRoot?: string): PersistentTerminalSession {
    return this.getOrCreate(sessionId, workspaceRoot)
  }

  public close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.closeShell()
      this.sessions.delete(sessionId)
    }
  }

  public closeSession(sessionId: string): void {
    this.close(sessionId)
  }

  public closeAll(): void {
    for (const session of this.sessions.values()) {
      session.closeShell()
    }
    this.sessions.clear()
  }

  public dispose(): void {
    this.closeAll()
  }
}

export const terminalManager = PersistentTerminalManager.getInstance()
