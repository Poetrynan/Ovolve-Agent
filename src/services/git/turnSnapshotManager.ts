import fs from 'node:fs'
import path from 'node:path'

export interface FileSnapshot {
  relativePath: string
  content: string | null // null means file was created in this turn (should be deleted on rollback)
  existed: boolean
}

export interface TurnSnapshot {
  turnId: string
  timestamp: number
  workspacePath: string
  files: Map<string, FileSnapshot>
}

export class TurnSnapshotManager {
  private static instance: TurnSnapshotManager
  private snapshots: Map<string, TurnSnapshot> = new Map()

  public static getInstance(): TurnSnapshotManager {
    if (!TurnSnapshotManager.instance) {
      TurnSnapshotManager.instance = new TurnSnapshotManager()
    }
    return TurnSnapshotManager.instance
  }

  /**
   * Record pre-modification state of a file before a tool modifies it
   */
  public recordFileBeforeMutation(turnId: string, workspacePath: string, targetFile: string): void {
    const absPath = path.resolve(workspacePath, targetFile)
    const relPath = path.relative(workspacePath, absPath)

    if (!this.snapshots.has(turnId)) {
      this.snapshots.set(turnId, {
        turnId,
        timestamp: Date.now(),
        workspacePath,
        files: new Map(),
      })
    }

    const snapshot = this.snapshots.get(turnId)!
    // Only record the very first pre-turn state of the file
    if (!snapshot.files.has(relPath)) {
      const exists = fs.existsSync(absPath)
      let content: string | null = null
      if (exists) {
        try {
          content = fs.readFileSync(absPath, 'utf-8')
        } catch {}
      }
      snapshot.files.set(relPath, {
        relativePath: relPath,
        content,
        existed: exists,
      })
    }
  }

  /**
   * Rollback all file changes made in a specific turn
   */
  public rollbackTurn(turnId: string): { success: boolean; restoredFiles: string[]; error?: string } {
    const snapshot = this.snapshots.get(turnId)
    if (!snapshot) {
      return { success: false, restoredFiles: [], error: `No snapshot found for turn ${turnId}` }
    }

    const restoredFiles: string[] = []

    try {
      for (const [relPath, fileSnap] of snapshot.files.entries()) {
        const absPath = path.resolve(snapshot.workspacePath, relPath)

        if (fileSnap.existed && fileSnap.content !== null) {
          // Restore original content
          const dir = path.dirname(absPath)
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(absPath, fileSnap.content, 'utf-8')
          restoredFiles.push(relPath)
        } else if (!fileSnap.existed && fs.existsSync(absPath)) {
          // Delete file created during turn
          fs.unlinkSync(absPath)
          restoredFiles.push(`[deleted] ${relPath}`)
        }
      }

      return { success: true, restoredFiles }
    } catch (err: any) {
      return { success: false, restoredFiles, error: err.message }
    }
  }

  public getSnapshot(turnId: string): TurnSnapshot | undefined {
    return this.snapshots.get(turnId)
  }

  public clearSnapshot(turnId: string): void {
    this.snapshots.delete(turnId)
  }
}
