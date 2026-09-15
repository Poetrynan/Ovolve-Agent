import fs from 'node:fs'
import path from 'node:path'

export interface ReplaceFileContentArgs {
  targetFile: string
  instruction?: string
  description?: string
  targetContent: string
  replacementContent: string
  allowMultiple?: boolean
  startLine?: number
  endLine?: number
}

export interface FileToolResult {
  ok: boolean
  content?: string
  error?: string
  replacedCount?: number
}

/**
 * Precision multi-line string replacement (Fast Diff Patcher)
 */
export function replaceFileContent(args: ReplaceFileContentArgs): FileToolResult {
  const { targetFile, targetContent, replacementContent, allowMultiple = false } = args

  if (!fs.existsSync(targetFile)) {
    return { ok: false, error: `File not found: ${targetFile}` }
  }

  let original = fs.readFileSync(targetFile, 'utf8')

  // Normalize line endings for reliable matching
  const hasCRLF = original.includes('\r\n')
  const normOriginal = original.replace(/\r\n/g, '\n')
  const normTarget = targetContent.replace(/\r\n/g, '\n')
  const normReplacement = replacementContent.replace(/\r\n/g, '\n')

  if (!normOriginal.includes(normTarget)) {
    return {
      ok: false,
      error: `Target content not found in ${targetFile}. Please ensure whitespace and indentation match exactly.`,
    }
  }

  const occurrences = normOriginal.split(normTarget).length - 1
  if (occurrences > 1 && !allowMultiple) {
    return {
      ok: false,
      error: `Found ${occurrences} occurrences of targetContent in ${targetFile}, but allowMultiple is false.`,
    }
  }

  const newNormContent = allowMultiple
    ? normOriginal.replaceAll(normTarget, normReplacement)
    : normOriginal.replace(normTarget, normReplacement)

  const finalContent = hasCRLF ? newNormContent.replace(/\n/g, '\r\n') : newNormContent
  fs.writeFileSync(targetFile, finalContent, 'utf8')

  return {
    ok: true,
    content: finalContent,
    replacedCount: allowMultiple ? occurrences : 1,
  }
}

/**
 * View file content with line slice support
 */
export function viewFile(
  filePath: string,
  startLine?: number,
  endLine?: number
): FileToolResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` }
  }

  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split(/\r?\n/)

  if (startLine !== undefined || endLine !== undefined) {
    const start = Math.max(1, startLine || 1)
    const end = Math.min(lines.length, endLine || lines.length)
    const slice = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n')
    return { ok: true, content: slice }
  }

  return { ok: true, content }
}

/**
 * Write entire file content (with auto directory creation)
 */
export function writeToFile(filePath: string, content: string, overwrite = true): FileToolResult {
  if (fs.existsSync(filePath) && !overwrite) {
    return { ok: false, error: `File already exists and overwrite is false: ${filePath}` }
  }

  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(filePath, content, 'utf8')
  return { ok: true, content }
}

export function readTextFile(workspaceRoot: string, relPath: string): string {
  const abs = path.resolve(workspaceRoot, relPath)
  return fs.readFileSync(abs, 'utf-8')
}

export function writeTextFile(workspaceRoot: string, relPath: string, content: string): string {
  const abs = path.resolve(workspaceRoot, relPath)
  const dir = path.dirname(abs)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
  return `Successfully wrote ${content.length} characters to ${relPath}`
}
