// src/store/checkpointStore.ts
// Session timeline (UB1): the checkpoint tree behind the turn rail.
//
// The backend already held all of this — `snapshot_store` has captured a
// pre-image before every mutating file call for a long time, and
// `GET /api/rollback` has been able to list them. Nothing in the UI ever read
// it. The only way back was the destructive withdraw on a user bubble, so
// "let me look at what that turn changed before I decide" had no answer.
//
// This store is deliberately read-mostly:
//   - listing / previewing / labelling go over REST (they are pure reads, plus
//     one cosmetic write),
//   - actually GOING BACK stays on the WS `session_truncate` action, because
//     history and files must be undone in the same round trip. Splitting that
//     across two transports is how the two halves drift apart.
import { create } from 'zustand'
import { fetchJson, sendJson, API_BASE } from '@lib/api'

/** One node on the timeline: a user turn, plus whatever it changed on disk. */
export interface CheckpointNode {
  /** Checkpoint key. Shared with the snapshot store. */
  seq: number
  /** Which user bubble this is (0-based) — the handle `session_truncate` takes. */
  ordinal: number
  preview: string
  createdAt: number
  /** Distinct paths this turn touched. 0 = a turn that only talked. */
  files: number
  tools: string[]
  /** User-given name. Empty means an automatic point. */
  label: string
  /** False when something in the turn was too large to snapshot. */
  recoverable: boolean
  /** True when this turn's changes were already rolled back / withdrawn. */
  folded: boolean
}

/** One path inside a checkpoint, for the read-only preview. */
export interface CheckpointPath {
  path: string
  /** 'file' | 'missing' | 'dir' | 'skip' — what we saw BEFORE the change. */
  kind: string
  tool_name: string
  /** Size of the stored pre-image; null for missing/dir/skip. */
  bytes: number | null
  created_at: number
  /** Whether something is at that path right now. */
  exists_now: boolean
}

interface CheckpointState {
  nodes: CheckpointNode[]
  /** Snapshot rows whose turn is no longer in history. Shown as a folded stub. */
  orphans: { seq: number; files: number; folded: boolean }[]
  loading: boolean
  error: string | null
  /** Previews cached per seq, so reopening a node doesn't refetch. */
  previews: Record<number, CheckpointPath[]>

  refresh: (sessionId?: string) => Promise<void>
  loadPreview: (seq: number, sessionId?: string) => Promise<CheckpointPath[]>
  setLabel: (seq: number, label: string, sessionId?: string) => Promise<void>
  /** Drop everything — called when the session changes under us. */
  reset: () => void
}

function q(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const useCheckpointStore = create<CheckpointState>((set, get) => ({
  nodes: [],
  orphans: [],
  loading: false,
  error: null,
  previews: {},

  refresh: async (sessionId) => {
    set({ loading: true, error: null })
    try {
      const d = await fetchJson<{ nodes: CheckpointNode[]; orphans: any[] }>(
        `${API_BASE}/api/checkpoints${q({ sessionId })}`,
      )
      set({ nodes: d.nodes || [], orphans: d.orphans || [], loading: false })
    } catch (e: any) {
      // A failed timeline must never break the chat around it — the rail just
      // falls back to being a plain scroll minimap.
      set({ loading: false, error: e?.message || '读取时间线失败' })
    }
  },

  loadPreview: async (seq, sessionId) => {
    const cached = get().previews[seq]
    if (cached) return cached
    try {
      const d = await fetchJson<{ paths: CheckpointPath[] }>(
        `${API_BASE}/api/checkpoints/preview${q({ sessionId, seq })}`,
      )
      const paths = d.paths || []
      set((s) => ({ previews: { ...s.previews, [seq]: paths } }))
      return paths
    } catch {
      return []
    }
  },

  setLabel: async (seq, label, sessionId) => {
    // Optimistic: a label is cosmetic, and the node re-reads on the next
    // refresh anyway. Failing silently here is better than a toast for a
    // rename.
    set((s) => ({ nodes: s.nodes.map((n) => (n.seq === seq ? { ...n, label } : n)) }))
    try {
      await sendJson(`${API_BASE}/api/checkpoints/label`, 'POST', {
        seq, label, ...(sessionId ? { sessionId } : {}),
      })
    } catch {
      /* keep the optimistic label; the next refresh corrects it */
    }
  },

  reset: () => set({ nodes: [], orphans: [], previews: {}, error: null }),
}))
