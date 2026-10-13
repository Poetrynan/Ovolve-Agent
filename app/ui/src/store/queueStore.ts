// src/store/queueStore.ts
// Prompt queue: UI mirror of the backend `MessageQueue.ui_*` layer.
//
// The backend is the single source of truth — all mutations go through WS events
// (queue_enqueue, queue_remove, queue_reorder, etc.) and the store only applies
// changes when the backend broadcasts a `queue_state` event back. This way:
//   1. The queue survives page-level "accidents" (F5 in dev mode).
//   2. Multiple windows (future) see the same queue.
//   3. Reconnect/refresh get the snapshot from the server immediately on connect.
//
// The local `items` array is a dumb projection — UI components read it for
// rendering the QueuePanel, drag-sort, edit-in-place, etc. DnD produces an
// optimistic reorder that gets confirmed/corrected by the next `queue_state`.
import { create } from 'zustand'

/** How a queued prompt asked to be delivered. */
export type QueueDelivery = 'queue' | 'steer'

/** Where a queued prompt is in its lifecycle. */
export type QueueItemState = 'waiting' | 'editing' | 'dispatching'

export interface QueuedPrompt {
  id: string
  /** The full prompt text, context refs already serialized in. */
  text: string
  delivery: QueueDelivery
  state: QueueItemState
  /** When it was enqueued — used for the "等待 3 分钟" label. */
  queuedAt: number
  /**
   * Why this ended up queued instead of doing what the user expected (2.4).
   * Empty when the outcome matched the request; a one-line explanation when it
   * didn't (e.g. "send" pressed mid-turn, or "steer" with nothing to steer).
   */
  fallbackReason?: string
}

/** Why the queue stopped draining on its own. */
export type PauseReason = 'interrupted' | 'error' | 'manual' | null

interface QueueState {
  items: QueuedPrompt[]
  paused: boolean
  pauseReason: PauseReason
  editingId: string | null

  /** Apply a full snapshot from the backend `queue_state` event. */
  applySnapshot: (payload: { items: any[]; paused: boolean; pauseReason: string | null }) => void

  // Local-only for inline editing UX (no WS round-trip needed):
  beginEdit: (id: string) => void
  endEdit: () => void

  // Convenience selectors:
  /** Number of items waiting. */
  depth: () => number
}

function toPrompt(raw: any): QueuedPrompt {
  return {
    id: raw.id ?? '',
    text: raw.text ?? '',
    delivery: raw.delivery === 'steer' ? 'steer' : 'queue',
    state: 'waiting',
    queuedAt: typeof raw.queuedAt === 'number' ? raw.queuedAt * 1000 : Date.now(),
    fallbackReason: typeof raw.fallbackReason === 'string' ? raw.fallbackReason : '',
  }
}

export const useQueueStore = create<QueueState>((set, get) => ({
  items: [],
  paused: false,
  pauseReason: null,
  editingId: null,

  applySnapshot: (payload) => {
    const editingId = get().editingId
    set({
      items: (payload.items || []).map((raw: any) => {
        const p = toPrompt(raw)
        // Preserve local "editing" state if the user is mid-edit
        if (p.id === editingId) p.state = 'editing'
        return p
      }),
      paused: !!payload.paused,
      pauseReason: (payload.pauseReason as PauseReason) ?? null,
    })
  },

  beginEdit: (id) =>
    set((s) => ({
      editingId: id,
      items: s.items.map((i) => (i.id === id ? { ...i, state: 'editing' as const } : i)),
    })),

  endEdit: () =>
    set((s) => ({
      editingId: null,
      items: s.items.map((i) => (i.state === 'editing' ? { ...i, state: 'waiting' as const } : i)),
    })),

  depth: () => get().items.length,
}))
