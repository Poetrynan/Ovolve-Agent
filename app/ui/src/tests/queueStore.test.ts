// src/tests/queueStore.test.ts
// The queue store is a MIRROR of the backend queue — these tests cover snapshot
// application and the local-only inline-edit state. The queue's real ordering /
// pause / take-next logic lives in Python (app/backend/messaging.py) and is
// tested there.
import { describe, it, expect, beforeEach } from 'vitest'
import { useQueueStore } from '@store/queueStore'

const act = useQueueStore.getState

function reset() {
  useQueueStore.setState({
    items: [],
    paused: false,
    pauseReason: null,
    editingId: null,
  })
}

/** Build a backend-shaped snapshot payload (queuedAt is epoch SECONDS). */
function snap(texts: string[], opts: { paused?: boolean; reason?: string | null } = {}) {
  return {
    items: texts.map((text, i) => ({
      id: `srv-${i}`,
      text,
      delivery: 'queue',
      queuedAt: 1_700_000_000 + i,
    })),
    paused: opts.paused ?? false,
    pauseReason: opts.reason ?? null,
  }
}

describe('queueStore (backend mirror)', () => {
  beforeEach(reset)

  it('applySnapshot replaces items in server order', () => {
    act().applySnapshot(snap(['a', 'b', 'c']))
    expect(act().items.map((i) => i.text)).toEqual(['a', 'b', 'c'])
  })

  it('converts backend epoch-seconds to millis', () => {
    act().applySnapshot(snap(['a']))
    expect(act().items[0].queuedAt).toBe(1_700_000_000 * 1000)
  })

  it('maps the steer delivery flag', () => {
    act().applySnapshot({
      items: [{ id: 'x', text: 'urgent', delivery: 'steer', queuedAt: 1 }],
      paused: false,
      pauseReason: null,
    })
    expect(act().items[0].delivery).toBe('steer')
  })

  it('defaults unknown delivery to queue', () => {
    act().applySnapshot({
      items: [{ id: 'x', text: 'plain', delivery: 'whatever', queuedAt: 1 }],
      paused: false,
      pauseReason: null,
    })
    expect(act().items[0].delivery).toBe('queue')
  })

  it('carries paused + reason through', () => {
    act().applySnapshot(snap(['a'], { paused: true, reason: 'interrupted' }))
    expect(act().paused).toBe(true)
    expect(act().pauseReason).toBe('interrupted')
  })

  it('an empty snapshot clears the queue', () => {
    act().applySnapshot(snap(['a', 'b']))
    act().applySnapshot(snap([]))
    expect(act().items).toHaveLength(0)
  })

  it('beginEdit / endEdit toggle the local editing state', () => {
    act().applySnapshot(snap(['a']))
    const id = act().items[0].id
    act().beginEdit(id)
    expect(act().editingId).toBe(id)
    expect(act().items[0].state).toBe('editing')
    act().endEdit()
    expect(act().editingId).toBeNull()
    expect(act().items[0].state).toBe('waiting')
  })

  it('a snapshot arriving mid-edit preserves the editing state', () => {
    act().applySnapshot(snap(['a', 'b']))
    const id = act().items[0].id
    act().beginEdit(id)
    // Server pushes an update (e.g. another item was removed)
    act().applySnapshot({
      items: [
        { id, text: 'a', delivery: 'queue', queuedAt: 1 },
      ],
      paused: false,
      pauseReason: null,
    })
    expect(act().items[0].state).toBe('editing')
  })

  it('depth reports the number of pending items', () => {
    act().applySnapshot(snap(['a', 'b', 'c']))
    expect(act().depth()).toBe(3)
  })

  it('tolerates a malformed payload without throwing', () => {
    act().applySnapshot({ items: undefined as any, paused: false, pauseReason: null })
    expect(act().items).toEqual([])
  })
})
