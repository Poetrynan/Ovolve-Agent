// What one turn changed on disk, derived from the tool calls it sealed.
//
// This is the data behind the summary under an assistant reply. Two rules
// shape it, and both come from the same place: the summary is a claim about
// the user's files, so it may only say things that actually happened.
//
//   1. Only calls that completed count. A `write_file` refused by a guard, or
//      one interrupted mid-turn, changed nothing — listing it would send the
//      reader to a diff that does not exist. The activity feed still shows the
//      attempt; this summary is about effects.
//   2. Numbers are either real or absent. Line counts come from a returned
//      patch when the tool reported one, otherwise from the replacement and
//      target content the model actually sent. When neither exists (a delete,
//      a move) the file keeps no numbers and the turn shows no total rather
//      than a subtotal silently missing a file.
import type { ToolCall } from '@apptypes/index'

export type ChangeAction = 'created' | 'edited' | 'deleted' | 'moved' | 'copied'

export interface ChangedFile {
  path: string
  name: string
  action: ChangeAction
  /** Lines added, when the call reported enough to know. */
  added?: number
  /** Lines removed, when the call reported enough to know. */
  removed?: number
}

export interface TurnChanges {
  files: ChangedFile[]
  /** Present only when every file carries both numbers. */
  added: number | null
  removed: number | null
}

const WRITE_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'create_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'apply_patch',
])
const DELETE_TOOLS = new Set(['delete_file', 'remove_file'])
const MOVE_TOOLS = new Set(['move_file', 'rename_file'])
const COPY_TOOLS = new Set(['copy_file'])
/**
 * Only tools that cannot overwrite. `write_file` may replace a file that was
 * already there, so calling it "created" would claim the old content is gone
 * with zero lines removed — a claim neither the args nor the result supports.
 */
const CREATE_TOOLS = new Set(['create_file'])

/** Arg spellings seen across the tool catalogue, most specific first. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'TargetFile', 'target', 'file'] as const
const TARGET_KEYS = ['TargetContent', 'target_content', 'targetContent', 'old_content', 'oldContent'] as const
const REPLACEMENT_KEYS = [
  'ReplacementContent',
  'replacement_content',
  'replacementContent',
  'CodeContent',
  'code_content',
  'codeContent',
  'content',
  'code',
  'text',
  'new_content',
  'newContent',
] as const

function pickString(args: Record<string, unknown> | undefined, keys: readonly string[]): string {
  if (!args) return ''
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

function lineCount(text: string): number | undefined {
  if (!text) return undefined
  return text.split('\n').length
}

/** Line counts from a unified patch, the only trustworthy source when present. */
function patchStat(text: string): { added?: number; removed?: number } {
  if (!text || (!text.includes('\n+') && !text.includes('\n-'))) return {}
  let added = 0
  let removed = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1
  }
  return added || removed ? { added, removed } : {}
}

function statsFor(
  action: ChangeAction,
  call: ToolCall,
): { added?: number; removed?: number } {
  if (action === 'moved' || action === 'copied') return {}

  const fromPatch = patchStat(typeof call.result === 'string' ? call.result : '')
  const target = pickString(call.args, TARGET_KEYS)
  const replacement = pickString(call.args, REPLACEMENT_KEYS)

  if (action === 'deleted') {
    // Neither the tool result nor the args carry the file's size. Say nothing
    // rather than guess at what was lost.
    return {}
  }

  const added = fromPatch.added ?? lineCount(replacement)
  const removed =
    action === 'created' ? 0 : fromPatch.removed ?? lineCount(target)

  return { added, removed }
}

/**
 * Reduce a turn's tool calls to the set of files it touched.
 *
 * One row per path, in first-touched order. A file created and then edited in
 * the same turn stays "created" — that is what it is from the reader's side —
 * while its numbers accumulate across the operations.
 */
export function changedFilesForTurn(toolCalls: ToolCall[]): TurnChanges {
  const order: string[] = []
  const byPath = new Map<string, ChangedFile>()

  for (const call of toolCalls) {
    if (call.status !== 'completed') continue
    const name = String(call.toolName || '')
    if (!name) continue

    const isWrite = WRITE_TOOLS.has(name)
    const isDelete = DELETE_TOOLS.has(name)
    const isMove = MOVE_TOOLS.has(name)
    const isCopy = COPY_TOOLS.has(name)
    if (!isWrite && !isDelete && !isMove && !isCopy) continue

    const path = isMove || isCopy
      ? pickString(call.args, ['dst', 'destination', ...PATH_KEYS])
      : pickString(call.args, PATH_KEYS)
    if (!path) continue

    const action: ChangeAction = isDelete
      ? 'deleted'
      : isMove
        ? 'moved'
        : isCopy
          ? 'copied'
          : CREATE_TOOLS.has(name)
            ? 'created'
            : 'edited'

    const stats = statsFor(action, call)
    const existing = byPath.get(path)
    if (existing) {
      // The row describes where the file ended up, so the latest operation's
      // numbers replace the earlier ones instead of summing every keystroke.
      existing.added = stats.added
      existing.removed = stats.removed
      if (existing.action !== 'created') existing.action = action
      continue
    }

    order.push(path)
    byPath.set(path, { path, name: basename(path), action, ...stats })
  }

  const files = order.map((path) => byPath.get(path)!)
  const fullyCounted =
    files.length > 0 &&
    files.every((f) => f.added !== undefined && f.removed !== undefined)

  return {
    files,
    added: fullyCounted ? files.reduce((sum, f) => sum + (f.added ?? 0), 0) : null,
    removed: fullyCounted ? files.reduce((sum, f) => sum + (f.removed ?? 0), 0) : null,
  }
}
