import path from 'node:path'

export type SandboxMode = 'workspace-strict' | 'workspace-read-only' | 'danger-full-access'

export class PathSandboxGuard {
  private workspaceRoot: string
  private mode: SandboxMode

  constructor(workspaceRoot = '.', mode: SandboxMode = 'workspace-strict') {
    this.workspaceRoot = path.resolve(workspaceRoot)
    this.mode = mode
  }

  public setWorkspaceRoot(root: string): void {
    this.workspaceRoot = path.resolve(root)
  }

  public setMode(mode: SandboxMode): void {
    this.mode = mode
  }

  public validatePath(targetPath: string, isWrite = false): { ok: boolean; resolvedPath: string; error?: string } {
    if (this.mode === 'danger-full-access') {
      return { ok: true, resolvedPath: path.resolve(targetPath) }
    }

    if (this.mode === 'workspace-read-only' && isWrite) {
      return {
        ok: false,
        resolvedPath: path.resolve(targetPath),
        error: `Sandbox violation: Workspace is in read-only mode. Write action denied on: ${targetPath}`,
      }
    }

    const resolved = path.resolve(this.workspaceRoot, targetPath)
    const relative = path.relative(this.workspaceRoot, resolved)

    // Check if relative path starts with '..' or is root escape
    const isEscaped = relative.startsWith('..') || path.isAbsolute(relative)

    if (isEscaped) {
      return {
        ok: false,
        resolvedPath: resolved,
        error: `Sandbox escape blocked: Target path "${targetPath}" is outside workspace root "${this.workspaceRoot}".`,
      }
    }

    return { ok: true, resolvedPath: resolved }
  }
}
