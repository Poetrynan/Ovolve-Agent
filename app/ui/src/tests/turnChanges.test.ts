import { describe, it, expect } from 'vitest'
import { changedFilesForTurn } from '../lib/turnChanges'
import type { ToolCall } from '../types'

function call(over: Partial<ToolCall> & Pick<ToolCall, 'toolName'>): ToolCall {
  return {
    id: `${over.toolName}-${Math.random().toString(36).slice(2)}`,
    args: {},
    status: 'completed',
    timestamp: 0,
    ...over,
  } as ToolCall
}

describe('changedFilesForTurn', () => {
  it('counts a completed write without claiming what it replaced', () => {
    const t = changedFilesForTurn([
      call({
        toolName: 'write_file',
        args: { path: 'src/a.ts', content: 'one\ntwo\nthree' },
        status: 'completed',
      }),
    ])
    expect(t.files).toHaveLength(1)
    // write_file may overwrite an existing file, so it is not "created".
    expect(t.files[0]).toMatchObject({ path: 'src/a.ts', name: 'a.ts', action: 'edited', added: 3 })
    expect(t.files[0].removed).toBeUndefined()
    expect(t.added).toBeNull()
  })

  it('counts a create_file as a new file', () => {
    const t = changedFilesForTurn([
      call({ toolName: 'create_file', args: { path: 'src/new.ts', content: 'one\ntwo' } }),
    ])
    expect(t.files[0]).toMatchObject({ action: 'created', added: 2, removed: 0 })
    expect(t.added).toBe(2)
    expect(t.removed).toBe(0)
  })

  it('ignores calls that did not complete', () => {
    const t = changedFilesForTurn([
      call({ toolName: 'write_file', args: { path: 'src/a.ts', content: 'x' }, status: 'failed' }),
      call({ toolName: 'edit_file', args: { path: 'src/b.ts' }, status: 'denied' }),
      call({ toolName: 'write_file', args: { path: 'src/c.ts', content: 'x' }, status: 'interrupted' }),
    ])
    expect(t.files).toEqual([])
    expect(t.added).toBeNull()
  })

  it('reports a delete without inventing line counts', () => {
    const t = changedFilesForTurn([
      call({ toolName: 'delete_file', args: { path: 'src/gone.ts' } }),
    ])
    expect(t.files[0]).toMatchObject({ path: 'src/gone.ts', action: 'deleted' })
    expect(t.files[0].added).toBeUndefined()
    expect(t.files[0].removed).toBeUndefined()
    // A total that silently omits the deleted file would understate the turn.
    expect(t.added).toBeNull()
    expect(t.removed).toBeNull()
  })

  it('takes edit numbers from the target and replacement content', () => {
    const t = changedFilesForTurn([
      call({
        toolName: 'edit_file',
        args: { path: 'src/a.ts', TargetContent: 'old 1\nold 2', ReplacementContent: 'new 1' },
      }),
    ])
    expect(t.files[0]).toMatchObject({ action: 'edited', added: 1, removed: 2 })
    expect(t.added).toBe(1)
    expect(t.removed).toBe(2)
  })

  it('prefers a patch the tool actually returned over content estimates', () => {
    const t = changedFilesForTurn([
      call({
        toolName: 'edit_file',
        args: { path: 'src/a.ts', TargetContent: 'a\nb\nc', ReplacementContent: 'a\nb\nc\nd' },
        result: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n a\n b\n c\n+d\n',
      }),
    ])
    expect(t.files[0]).toMatchObject({ added: 1, removed: 0 })
  })

  it('keeps one row per file and describes its final state', () => {
    const t = changedFilesForTurn([
      call({ toolName: 'create_file', args: { path: 'src/a.ts', content: 'one' } }),
      call({
        toolName: 'edit_file',
        args: { path: 'src/a.ts', TargetContent: 'one', ReplacementContent: 'one\ntwo' },
      }),
    ])
    expect(t.files).toHaveLength(1)
    // Created first, edited after: still a created file for the reader, with
    // the last operation's numbers rather than a sum of both.
    expect(t.files[0].action).toBe('created')
    expect(t.files[0]).toMatchObject({ added: 2, removed: 1 })
    expect(t.added).toBe(2)
    expect(t.removed).toBe(1)
  })

  it('shows the destination of a move and no numbers', () => {
    const t = changedFilesForTurn([
      call({ toolName: 'move_file', args: { src: 'src/old.ts', dst: 'src/new.ts' } }),
    ])
    expect(t.files).toEqual([
      { path: 'src/new.ts', name: 'new.ts', action: 'moved' },
    ])
    expect(t.added).toBeNull()
  })

  it('ignores read and shell tools', () => {
    const t = changedFilesForTurn([
      call({ toolName: 'read_file', args: { path: 'src/a.ts' } }),
      call({ toolName: 'run_command', args: { command: 'echo hi' } }),
      call({ toolName: 'grep_search', args: { pattern: 'x' } }),
    ])
    expect(t.files).toEqual([])
  })
})
