/**
 * ToolOutputSpill.ts — Tool Output Spill Manager & Bounded Preview System
 *
 * Responsibilities:
 * 1. Intercept massive tool execution outputs (>16,000 chars / ~4,000 tokens).
 * 2. Persist verbatim raw logs to disk in `.ovolve/spills/` to prevent context exhaustion.
 * 3. Generate compact Head-Tail bounded previews for the agent context.
 * 4. Provide slice reading (`readSpill`) for precision on-demand inspection.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export interface SpillResult {
  isSpilled: boolean
  content: string
  spillId?: string
  spillPath?: string
  totalChars: number
  totalLines: number
}

export class ToolOutputSpillManager {
  private thresholdChars: number
  private headLines: number
  private tailLines: number
  private spillDir: string

  constructor(
    thresholdChars = 16000,
    headLines = 40,
    tailLines = 40,
    spillDir = '.ovolve/spills'
  ) {
    this.thresholdChars = thresholdChars
    this.headLines = headLines
    this.tailLines = tailLines
    this.spillDir = spillDir

    try {
      if (!fs.existsSync(this.spillDir)) {
        fs.mkdirSync(this.spillDir, { recursive: true })
      }
    } catch {}
  }

  public getSpillDir(): string {
    return this.spillDir
  }

  public getThresholdChars(): number {
    return this.thresholdChars
  }

  /**
   * Process and check raw tool output. If exceeding threshold, spill to disk and return bounded preview.
   */
  public processOutput(
    rawOutput: string,
    toolName = 'tool',
    sessionId = 'default',
    workspace?: string
  ): SpillResult {
    if (!rawOutput) {
      return {
        isSpilled: false,
        content: '',
        totalChars: 0,
        totalLines: 0,
      }
    }

    const totalChars = rawOutput.length
    const lines = rawOutput.split(/\r?\n/)
    const totalLines = lines.length

    if (totalChars <= this.thresholdChars) {
      return {
        isSpilled: false,
        content: rawOutput,
        totalChars,
        totalLines,
      }
    }

    // Determine target directory
    let targetDir = this.spillDir
    if (workspace && typeof workspace === 'string' && fs.existsSync(workspace)) {
      targetDir = path.join(workspace, '.ovolve', 'spills')
    }

    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
      }
    } catch {}

    const spillId = `spill_${crypto.randomBytes(4).toString('hex')}`
    const fileName = `${spillId}_${toolName}_${sessionId}.txt`
    const filePath = path.join(targetDir, fileName)

    try {
      fs.writeFileSync(filePath, rawOutput, 'utf8')
    } catch (e: any) {
      // Fallback if writing fails
      return {
        isSpilled: true,
        content: rawOutput.slice(0, 1000) + `\n\n[Warning: Failed to write spill file: ${e.message}]`,
        totalChars,
        totalLines,
      }
    }

    const headSlice = lines.slice(0, this.headLines)
    const tailSlice = lines.slice(Math.max(this.headLines, totalLines - this.tailLines))
    const headPart = headSlice.join('\n')
    const tailPart = tailSlice.join('\n')
    const omittedLines = Math.max(0, totalLines - this.headLines - this.tailLines)
    const omittedChars = Math.max(0, totalChars - headPart.length - tailPart.length)

    const renderedPreview = [
      `[⚠️ 工具 \`${toolName}\` 输出过长（共 ${totalChars} 字符 / ${totalLines} 行），已自动安全转储至磁盘以节省 Token 并防止上下文污染]`,
      `· 转储文件路径: ${filePath}`,
      `· Spill ID: ${spillId}`,
      ``,
      `=== 头部输出 (前 ${Math.min(this.headLines, totalLines)} 行) ===`,
      headPart,
      ``,
      `... [中间已安全省略 ${omittedLines} 行 / ${omittedChars} 字符；如需精准查阅，可通过 read_spill 工具查看完整文件] ...`,
      ``,
      `=== 尾部输出 (后 ${Math.min(this.tailLines, totalLines - this.headLines)} 行) ===`,
      tailPart,
    ].join('\n')

    return {
      isSpilled: true,
      content: renderedPreview,
      spillId,
      spillPath: filePath,
      totalChars,
      totalLines,
    }
  }

  /**
   * Reads a slice of lines from a persisted spill file
   */
  public readSpill(spillPath: string, startLine = 1, lineCount = 100): string {
    if (!fs.existsSync(spillPath)) {
      return `Error: Spill file not found: ${spillPath}`
    }

    try {
      const text = fs.readFileSync(spillPath, 'utf8')
      const lines = text.split(/\r?\n/)
      const start = Math.max(1, startLine)
      const end = Math.min(lines.length, start - 1 + lineCount)
      const slice = lines.slice(start - 1, end)
      return slice.map((l, i) => `${start + i} | ${l}`).join('\n')
    } catch (e: any) {
      return `Error reading spill file: ${e.message}`
    }
  }

  /**
   * Cleanup old spills exceeding max age in ms (default 24 hours)
   */
  public cleanSpills(maxAgeMs = 24 * 60 * 60 * 1000): number {
    let deletedCount = 0
    if (!fs.existsSync(this.spillDir)) return 0

    try {
      const files = fs.readdirSync(this.spillDir)
      const now = Date.now()
      for (const file of files) {
        const fullPath = path.join(this.spillDir, file)
        try {
          const stat = fs.statSync(fullPath)
          if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(fullPath)
            deletedCount++
          }
        } catch {}
      }
    } catch {}

    return deletedCount
  }
}

let defaultSpillManager: ToolOutputSpillManager | null = null

export function getSpillManager(spillDir?: string): ToolOutputSpillManager {
  if (!defaultSpillManager || spillDir) {
    defaultSpillManager = new ToolOutputSpillManager(16000, 40, 40, spillDir)
  }
  return defaultSpillManager
}
