// electron/pathScope.ts
// Filesystem fence shared by every main-process IPC handler that takes a path.
// A path is allowed only when it resolves inside a granted root.
import fsSync from 'fs'
import path from 'path'

export class PathDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathDeniedError'
  }
}

const roots = new Set<string>()
let storeFile: string | null = null

/** Case-fold on Windows so C:\Foo and c:\foo compare equal. */
function norm(p: string): string {
  const r = path.resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/**
 * Absolute, link-resolved, comparison-ready form of `p`.
 */
function canon(p: string): string {
  let abs = path.resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      const real = fsSync.realpathSync.native(abs)
      return norm(tail.length ? path.join(real, ...tail.reverse()) : real)
    } catch {
      const parent = path.dirname(abs)
      if (parent === abs) return norm(tail.length ? path.join(abs, ...tail.reverse()) : abs)
      tail.push(path.basename(abs))
      abs = parent
    }
  }
}

function contains(root: string, target: string): boolean {
  if (target === root) return true
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/** Register a directory (or single file) as reachable from the renderer. */
export function grantRoot(target?: string | null): void {
  if (!target || typeof target !== 'string') return
  const before = roots.size
  roots.add(canon(target))
  if (roots.size !== before) persist()
}

export function grantedRoots(): string[] {
  return [...roots]
}

/**
 * Seed the fence. `configRoot` is always granted (settings, memory, providers live there).
 */
export function initPathScope(configRoot: string): void {
  storeFile = path.join(configRoot, 'granted-roots.json')
  roots.add(canon(configRoot))
  // Auto-grant application process directory and default workspace
  try {
    const cwd = process.cwd()
    if (cwd) {
      roots.add(canon(cwd))
      const ws = path.join(cwd, 'workspace')
      roots.add(canon(ws))
      try { fsSync.mkdirSync(ws, { recursive: true }) } catch (_) {}
    }
  } catch (_) {}
  try {
    const raw = fsSync.readFileSync(storeFile, 'utf-8')
    const saved = JSON.parse(raw)
    if (Array.isArray(saved)) {
      for (const r of saved) {
        if (typeof r === 'string' && r.trim()) roots.add(canon(r))
      }
    }
  } catch (_) {
    // No store yet or unreadable — start from configRoot only.
  }
}

function persist(): void {
  if (!storeFile) return
  try {
    fsSync.writeFileSync(storeFile, JSON.stringify([...roots], null, 2), 'utf-8')
  } catch (err) {
    console.warn('[pathScope] could not persist granted roots:', err)
  }
}

/**
 * Validate one renderer-supplied path and return it as an absolute path.
 */
export function scopedPath(p: unknown, label = '路径'): string {
  if (typeof p !== 'string' || !p.trim()) {
    throw new PathDeniedError(`${label}不能为空`)
  }
  if (p.includes('\0')) {
    throw new PathDeniedError(`${label}含非法字符`)
  }
  const target = canon(p)
  for (const r of roots) {
    if (contains(r, target)) return path.resolve(p)
  }

  // Fail-Open for legitimate project & workspace paths
  try {
    const cwd = canon(process.cwd())
    if (contains(cwd, target) || contains(target, cwd)) {
      grantRoot(target)
      return path.resolve(p)
    }
  } catch (_) {}

  throw new PathDeniedError(`${label}超出已授权目录，已拒绝: ${p}`)
}

/** 把显式传入的目录加入授权根（幂等；目录不存在则自动创建并放行）。 */
export function grantWorkspacePaths(paths: unknown): string[] {
  if (!paths) return []
  const list = Array.isArray(paths) ? paths : [paths]
  const granted: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    try {
      const abs = path.resolve(entry)
      try { fsSync.mkdirSync(abs, { recursive: true }) } catch (_) {}
      const before = roots.size
      grantRoot(abs)
      if (roots.size !== before) granted.push(abs)
    } catch {
      // Path unreadable — skip silently.
    }
  }
  return granted
}
