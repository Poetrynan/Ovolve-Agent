import { create } from 'zustand'
import { useAgentStore } from '@store/agentStore'
import { useSidePanelStore } from '@store/sidePanelStore'
import { grantWorkspacesToMain } from '@/lib/workspaceGrant'

/**
 * Conversation history + workspace management for the sidebar.
 *
 * The backend owns both the session list and the active workspace — this
 * store is a mirror. Mutations go out as WS frames and the authoritative
 * events come back; we never optimistically rewrite, because a failed switch
 * (turn in flight) must not leave the UI showing something the server didn't do.
 */

export interface SessionSummary {
  id: string
  title: string
  created_at: number
  updated_at: number
  pinned: number
  workspace: string
  message_count: number
  /**
   * Set when this session was forked off another one (UA1). Without surfacing
   * it, a branch is just another flat row in the sidebar and the relationship
   * that makes it meaningful — "this is the other way I tried that" — is
   * invisible. Null/absent for ordinary sessions.
   */
  parent_id?: string | null
  /** The parent seq the fork was taken at. */
  branch_point?: number | null
}

export interface WorkspaceSummary {
  path: string
  session_count: number
  last_used: number
  display_name: string
  pinned: number
}

/**
 * Per-session liveness, shown as a dot on the sidebar row.
 *
 *   working — a turn is in flight in that session RIGHT NOW (animated dot)
 *   done    — the turn finished and the user hasn't looked yet (green dot)
 *   failed  — the turn ended in an error the user hasn't looked at (red dot)
 *
 * `done`/`failed` are deliberately STICKY: their whole job is to survive until
 * the user actually opens the session. If they cleared on their own, a turn
 * that finished while the user was in another workspace would leave no trace
 * and the work would silently go unreviewed — which is the exact failure this
 * indicator exists to prevent.
 */
export type SessionActivity = 'working' | 'done' | 'failed'

interface SessionListState {
  sessions: SessionSummary[]
  activeId: string | null
  activeWorkspace: string
  workspaces: WorkspaceSummary[]
  /** Free-text filter applied client-side. */
  query: string
  /** Which workspace folders are collapsed in the sidebar. */
  collapsed: Set<string>
  /** sessionId -> liveness badge. Absent means "nothing to show". */
  activity: Record<string, SessionActivity>

  setQuery: (q: string) => void
  toggleCollapsed: (ws: string) => void
  /** Mark a session as having a turn in flight. */
  markWorking: (sessionId: string) => void
  /** Mark a session's turn as settled. Sticky until the user opens it. */
  markSettled: (sessionId: string, ok: boolean) => void
  /** Drop the badge — called when the user actually looks at the session. */
  clearActivity: (sessionId: string) => void
  /** Replace the mirror from a `session_list` event. */
  applyList: (sessions: SessionSummary[], activeId: string, activeWorkspace?: string) => void
  applyWorkspaces: (workspaces: WorkspaceSummary[], active: string) => void
  /** Optimistically update or add a session row on user send so sidebar updates with 0ms latency. */
  touchOrAddSession: (sessionId: string, title?: string, workspace?: string) => void
  refresh: () => void
  newSession: () => void
  switchTo: (id: string) => void
  remove: (id: string) => void
  rename: (id: string, title: string) => void
  togglePin: (id: string, pinned: boolean) => void
  switchWorkspace: (path: string) => void
  requestWorkspaceList: () => void
  /** Give a workspace folder a custom label (empty string reverts to path tail). */
  renameWorkspace: (path: string, displayName: string) => void
  /** Sticky-top a workspace above the unpinned ones. */
  pinWorkspace: (path: string, pinned: boolean) => void
  /** Remove from the sidebar list. Sessions are kept — this is not a delete. */
  hideWorkspace: (path: string) => void
  /** Open a second app window on this folder (Electron only; no-op on web). */
  openWorkspaceWindow: (path: string) => Promise<void>
}

export const useSessionListStore = create<SessionListState>((set, get) => ({
  sessions: [],
  activeId: null,
  activeWorkspace: '',
  workspaces: [],
  query: '',
  collapsed: new Set(),
  activity: {},

  setQuery: (query) => set({ query }),
  toggleCollapsed: (ws) => {
    const next = new Set(get().collapsed)
    if (next.has(ws)) next.delete(ws); else next.add(ws)
    set({ collapsed: next })
  },

  markWorking: (sessionId) => {
    if (!sessionId) return
    set((s) => ({ activity: { ...s.activity, [sessionId]: 'working' } }))
  },
  markSettled: (sessionId, ok) => {
    if (!sessionId) return
    const activeId = get().activeId
    if (sessionId === activeId) {
      // When the turn finishes on the currently active session, the user is already viewing it live
      // Clear the activity badge so no stale unread/done dot lingers on the active row
      set((s) => {
        if (!s.activity[sessionId]) return s
        const next = { ...s.activity }
        delete next[sessionId]
        return { activity: next }
      })
      return
    }
    set((s) => ({ activity: { ...s.activity, [sessionId]: ok ? 'done' : 'failed' } }))
  },
  clearActivity: (sessionId) => {
    if (!sessionId) return
    set((s) => {
      const cur = s.activity[sessionId]
      if (!cur) return s
      const next = { ...s.activity }
      delete next[sessionId]
      return { activity: next }
    })
  },


  // Canonicalize `activeWorkspace` at the store boundary so every consumer
  // compares canonical-to-canonical. Without this, a backend that reports the
  // active folder as `'.'` would never match the merged `''` group key and the
  // sidebar would highlight nothing as active.
  applyList: (sessions, activeId, activeWorkspace) => set({
    sessions,
    activeId,
    ...(activeWorkspace !== undefined
      ? { activeWorkspace: canonicalWorkspace(activeWorkspace) }
      : {}),
  }),
  applyWorkspaces: (workspaces, active) => set({
    workspaces,
    activeWorkspace: canonicalWorkspace(active),
  }),

  touchOrAddSession: (sessionId, title, workspace) => {
    if (!sessionId) return
    set((state) => {
      const ws = workspace !== undefined ? canonicalWorkspace(workspace) : state.activeWorkspace
      const existingIdx = state.sessions.findIndex((s) => s.id === sessionId)
      const now = Math.floor(Date.now() / 1000)
      const nextActivity = { ...state.activity, [sessionId]: 'working' as SessionActivity }

      if (existingIdx >= 0) {
        const existing = state.sessions[existingIdx]
        const nextTitle = (existing.title === 'New chat' || existing.title === 'Main Session' || !existing.title) && title
          ? title
          : existing.title
        const updated: SessionSummary = {
          ...existing,
          title: nextTitle,
          updated_at: now,
          message_count: (existing.message_count || 0) + 1,
        }
        const rest = state.sessions.filter((_, i) => i !== existingIdx)
        return {
          sessions: [updated, ...rest],
          activeId: sessionId,
          activity: nextActivity,
        }
      }

      const newSession: SessionSummary = {
        id: sessionId,
        title: title || '新对话',
        created_at: now,
        updated_at: now,
        pinned: 0,
        workspace: ws,
        message_count: 1,
      }
      return {
        sessions: [newSession, ...state.sessions],
        activeId: sessionId,
        activity: nextActivity,
      }
    })
  },

  refresh: () => { useAgentStore.getState().send('session_list') },
  newSession: () => {
    useSidePanelStore.getState().switchSession(null)
    useAgentStore.getState().send('session_new')
  },
  switchTo: (id) => {
    if (id === get().activeId) return
    useSidePanelStore.getState().switchSession(id)
    get().clearActivity(id)  // opening the session IS the review — drop its badge
    useAgentStore.getState().send('session_switch', { sessionId: id })
  },
  remove: (id) => { useAgentStore.getState().send('session_delete', { sessionId: id }) },
  rename: (id, title) => { useAgentStore.getState().send('session_rename', { sessionId: id, title }) },
  togglePin: (id, pinned) => { useAgentStore.getState().send('session_pin', { sessionId: id, pinned }) },
  switchWorkspace: (path) => {
    grantWorkspacesToMain(path)
    useAgentStore.getState().send('workspace_switch', { path })
  },
  requestWorkspaceList: () => { useAgentStore.getState().send('workspace_list') },

  renameWorkspace: (path, displayName) => {
    if (!path) return  // the default workspace has no row to rename
    useAgentStore.getState().send('workspace_rename', { path, displayName })
  },
  pinWorkspace: (path, pinned) => {
    if (!path) return
    useAgentStore.getState().send('workspace_pin', { path, pinned })
  },
  hideWorkspace: (path) => {
    if (!path) return
    useAgentStore.getState().send('workspace_hide', { path, hidden: true })
  },
  openWorkspaceWindow: async (path) => {
    const api = (window as any).electronAPI
    if (!path || !api?.invoke) return
    try {
      await api.invoke('workspace:openNewWindow', path)
    } catch (err) {
      console.warn('[sessionListStore] openNewWindow failed', err)
    }
  },
}))

/** Compact "how long ago" label. */
export function relativeTime(epochSeconds: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - epochSeconds * 1000)
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}小时`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天`
  const months = Math.floor(days / 30)
  return `${months}月`
}

/**
 * Collapse every spelling of "the default workspace" onto ONE key.
 *
 * The backend has written `''`, `'.'` and `'./'` at different points in the
 * project's life, and `labelFor()` renders all of them as 默认工作区. If the
 * grouping key stays raw, the sidebar shows two (or three) identical
 * 默认工作区 rows that the user has no way to tell apart — the label says
 * they're the same place, the tree says they're not.
 *
 * Identity must be decided here, not at render time. Also trims a trailing
 * separator so `C:\foo\` and `C:\foo` are one folder, which is the same class
 * of bug for real paths.
 */
export function canonicalWorkspace(workspace: string): string {
  const raw = (workspace || '').trim()
  if (!raw || raw === '.' || raw === './' || raw === '.\\') return ''
  // Strip a trailing slash/backslash, but never turn `C:\` into `C:`.
  const trimmed = raw.replace(/[\\/]+$/, '')
  return trimmed || raw
}

/** Group sessions by workspace folder for the sidebar tree.
 *
 * Driven by BOTH the session list and the explicit workspace list: a folder the
 * user opened but hasn't chatted in yet still needs a row (it has zero
 * sessions, so it would never appear from `sessions` alone). The workspace list
 * also carries the custom `display_name` and `pinned` flag, which decide the
 * label and sort order. When a search query is active we only show workspaces
 * with at least one matching session — an empty folder can't match a title.
 *
 * Keys are canonicalized (see `canonicalWorkspace`) so two spellings of the
 * same folder merge into one row instead of appearing as duplicates.
 */
export function groupByWorkspace(
  sessions: SessionSummary[],
  query: string,
  workspaces: WorkspaceSummary[] = [],
) {
  const q = query.trim().toLowerCase()
  const filtered = q
    ? sessions.filter((s) => (s.title || '').toLowerCase().includes(q))
    : sessions

  const groups = new Map<string, SessionSummary[]>()
  for (const s of filtered) {
    const ws = canonicalWorkspace(s.workspace)
    if (!groups.has(ws)) groups.set(ws, [])
    groups.get(ws)!.push(s)
  }

  // Fold in explicit workspace rows (opened, maybe empty). Skip while searching.
  // Canonical keys here too, otherwise an injected `'.'` row would re-create the
  // duplicate this function just merged away.
  const meta = new Map<string, WorkspaceSummary>()
  for (const w of workspaces) {
    const key = canonicalWorkspace(w.path)
    // First writer wins for display_name/pinned; a later alias of the same
    // folder shouldn't clobber a name the user actually set.
    if (!meta.has(key)) meta.set(key, w)
    if (!q && !groups.has(key)) groups.set(key, [])
  }

  const lastUpdated = (items: SessionSummary[], path: string) => {
    const fromSessions = items.length ? Math.max(...items.map((s) => s.updated_at)) : 0
    return Math.max(fromSessions, meta.get(path)?.last_used || 0)
  }

  const sorted = [...groups.entries()].sort((a, b) => {
    const aPin = meta.get(a[0])?.pinned ? 1 : 0
    const bPin = meta.get(b[0])?.pinned ? 1 : 0
    if (aPin !== bPin) return bPin - aPin
    // Default workspace (empty string) always last unless it's the only one.
    if (a[0] === '' && b[0] !== '') return 1
    if (b[0] === '' && a[0] !== '') return -1
    return lastUpdated(b[1], b[0]) - lastUpdated(a[1], a[0])
  })

  return sorted.map(([workspace, items]) => {
    const custom = meta.get(workspace)?.display_name
    const label = custom || labelFor(workspace)
    return {
      workspace,
      label,
      pinned: !!meta.get(workspace)?.pinned,
      sessions: items,
    }
  })
}

/**
 * Turn a raw workspace path into something a human should see on screen.
 *
 * Empty / dot / current-dir shorthand all collapse to "默认工作区" — the user
 * doesn't need to know it's `os.getcwd()` under the hood, and a single black
 * dot label ("." → last-segment) reads as a rendering bug rather than a real
 * folder. Real paths use their last non-empty segment (Windows and POSIX
 * separators), falling back to the whole string if there is no segment to
 * pick.
 */
function labelFor(workspace: string): string {
  const raw = (workspace || '').trim()
  if (!raw || raw === '.' || raw === './' || raw === '.\\') return '默认工作区'
  const parts = raw.split(/[\\/]/).filter(Boolean)
  const tail = parts[parts.length - 1]
  if (!tail || tail === '.') return '默认工作区'
  return tail
}
