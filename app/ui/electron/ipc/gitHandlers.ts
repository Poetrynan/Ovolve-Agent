// electron/ipc/gitHandlers.ts
// Thin wrappers over the `git` CLI. Renderer already talks to the Python
// backend for higher-level operations; these IPC handlers are for cases where
// we want low-latency, main-process shell access (branch list, checkout, …).
import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import type { IPCContext } from './index'
import { scopedPath } from '../pathScope'

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

/**
 * Options that make git execute an arbitrary command. `spawn` runs without a
 * shell, so shell metacharacters are not the exposure here -- git's *own*
 * option parser is: `--upload-pack=<cmd>` / `--receive-pack=<cmd>` run <cmd>
 * on fetch/push, `-c core.pager=<cmd>` or `-c alias.x=!<cmd>` run it for
 * almost any subcommand, and `--exec-path` relocates every git-* helper to a
 * directory of the caller's choosing.
 */
const FORBIDDEN_OPTS = [
  '-c',
  '--config-env',
  '--exec-path',
  '--upload-pack',
  '--receive-pack',
  '--upload-archive',
  '--git-dir',
  '--work-tree',
  '--namespace',
]

/**
 * Subcommands `git:run` may invoke. The channel exists for low-latency
 * inspection from the renderer, so it is an inspect-and-stage list: nothing
 * here rewrites history, deletes work, or talks to the network. The named
 * channels below (git:status/branches/log) pass their own fixed argv and are
 * validated by the same function, which is why their verbs appear too.
 */
const ALLOWED_SUBCOMMANDS = new Set([
  'status', 'rev-parse', 'branch', 'log', 'diff', 'show', 'blame',
  'ls-files', 'ls-tree', 'describe', 'symbolic-ref', 'for-each-ref',
  'shortlog', 'name-rev', 'cat-file', 'remote',
  'add', 'commit', 'restore', 'checkout', 'switch', 'stash',
])

class GitArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitArgError'
  }
}

function assertSafeArgs(args: unknown): string[] {
  if (!Array.isArray(args) || args.length === 0) {
    throw new GitArgError('git 参数必须是非空数组')
  }
  const list = args.map((a) => {
    if (typeof a !== 'string') throw new GitArgError(`git 参数必须是字符串: ${String(a)}`)
    if (/[\0\r\n]/.test(a)) throw new GitArgError('git 参数含非法控制字符')
    return a
  })
  const sub = list[0]
  if (!ALLOWED_SUBCOMMANDS.has(sub)) {
    throw new GitArgError(`git 子命令不在白名单内: ${sub}`)
  }
  for (const a of list) {
    const name = a.split('=')[0]
    if (FORBIDDEN_OPTS.includes(name)) {
      throw new GitArgError(`git 参数被拒绝（可用于执行任意命令）: ${a}`)
    }
  }
  return list
}

function runGit(cwd: string, args: string[], timeoutMs = 15_000): Promise<GitResult> {
  let safeCwd: string
  let safeArgs: string[]
  try {
    safeCwd = scopedPath(cwd, 'git 工作目录')
    safeArgs = assertSafeArgs(args)
  } catch (err: any) {
    return Promise.resolve({ ok: false, stdout: '', stderr: err?.message || String(err), code: -1 })
  }
  return new Promise((resolve) => {
    const proc = spawn('git', ['-c', 'core.quotePath=false', ...safeArgs], {
      cwd: safeCwd, windowsHide: true,
      // Force UTF-8 decoding on all platforms so Chinese branch names / commit
      // subjects don't produce mojibake on Windows (where default is GBK).
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

export function registerGitHandlers(_ctx: IPCContext) {
  ipcMain.handle('git:run', async (_e, cwd: string, args: string[]) => runGit(cwd, args))

  ipcMain.handle('git:status', async (_e, cwd: string) => {
    const [porcelain, branch] = await Promise.all([
      runGit(cwd, ['status', '--porcelain=v1', '-z']),
      runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ])
    if (!porcelain.ok) return { ok: false, error: porcelain.stderr }
    const rows = porcelain.stdout.split('\x00').filter(Boolean).map((line) => {
      const kind = line.slice(0, 2)
      const filePath = line.slice(3)
      return { kind, path: filePath }
    })
    return {
      ok: true,
      branch: branch.stdout.trim() || 'HEAD',
      changes: rows,
    }
  })

  ipcMain.handle('git:branches', async (_e, cwd: string) => {
    const r = await runGit(cwd, ['branch', '--all', '--format=%(refname:short)'])
    if (!r.ok) return { ok: false, error: r.stderr }
    const branches = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    return { ok: true, branches }
  })

  ipcMain.handle('git:log', async (_e, cwd: string, limit = 50) => {
    // `limit` is interpolated into an argv entry, so it must be a bounded int
    // and never carry through as a caller-chosen string.
    const n = Math.max(1, Math.min(1000, Number(limit) || 50))
    const r = await runGit(cwd, [
      'log',
      `-n${n}`,
      '--pretty=format:%H\x1f%h\x1f%s\x1f%an\x1f%ad',
      '--date=iso-strict',
    ])
    if (!r.ok) return { ok: false, error: r.stderr }
    const rows = r.stdout.split('\n').filter(Boolean).map((line) => {
      const [hash, shortHash, subject, author, date] = line.split('\x1f')
      return { hash, shortHash, subject, author, date }
    })
    return { ok: true, commits: rows }
  })
}
