// src/store/sidePanelStore.ts
// Which panels the user has opened in the right-hand workspace column.
//
// This replaces two independent `useState` tab pickers — one in `ChatPage`
// (Git / Files / Browser) and one inside `SidePanel` (Files / Artifacts /
// Automations / Sub-agents) — that between them rendered two rows of tabs in a
// column ~300px wide. The inner row gave every tab `flex-1`, so five Chinese
// labels were each allotted a fifth of the width and `truncate` cut them to a
// single character: 文 / 产 / 自 / 子.
//
// The fix is not a narrower font. It is to stop treating the tab strip as a
// *menu of features* and treat it as *the set of things the user opened*, which
// is what every comparable tool does. The full feature list moves into a picker
// (the empty state, and the `+` button), so the strip only ever holds as many
// tabs as the user asked for.
import { create } from 'zustand'
import { useSessionListStore } from './sessionListStore'


/** Panels that can be opened in the right column (static ids). */
export type StaticSidePanelTabId = 'git' | 'files' | 'editor' | 'artifacts' | 'automations' | 'subagents' | 'browser' | 'session_learning'

/** Static panels, or `terminal:<sessionId>` for multiple terminal tabs. */
export type SidePanelTabId = StaticSidePanelTabId | `terminal:${string}` | 'terminal'

export function isTerminalTabId(id: string): boolean {
  return id === 'terminal' || id.startsWith('terminal:')
}

export function terminalSessionId(tabId: string): string {
  if (tabId === 'terminal') return 'ovolve-user-terminal'
  if (tabId.startsWith('terminal:')) return tabId.slice('terminal:'.length)
  return tabId
}

export function newTerminalTabId(): `terminal:${string}` {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return `terminal:ovolve-${suffix}`
}

export interface ActiveEditorPayload {
  filePath: string
  filename: string
  /** Pure code viewer content for read/inspect operations (no green diff lines). */
  content?: string
  targetContent?: string
  replacementContent?: string
  diff?: string
  startLine?: number
  added?: number
  removed?: number
  action?: string
  status?: string
  readOnly?: boolean
  fileNotFound?: boolean
  /** When multiple files were edited in the turn, list of all changed files for multi-file switching. */
  allFiles?: ActiveEditorPayload[]
}


const STATIC_TABS: readonly StaticSidePanelTabId[] = [
  'session_learning',
  'editor',
  'git',
  'files',
  'artifacts',
  'automations',
  'subagents',
  'browser',
]

function isStaticTabId(id: string): id is StaticSidePanelTabId {
  return (STATIC_TABS as readonly string[]).includes(id)
}

function normalizeTabId(id: string): SidePanelTabId {
  if (isStaticTabId(id) || isTerminalTabId(id)) return id as SidePanelTabId
  return 'files'
}

const STORAGE_KEY = 'ovolve-side-panel-tabs'

export interface SessionPanelSnapshot {
  openTabs: SidePanelTabId[]
  activeTab: SidePanelTabId | null
  activeEditor: ActiveEditorPayload | null
}

interface Persisted {
  openTabs: SidePanelTabId[]
  activeTab: SidePanelTabId | null
  /**
   * Stable display names for terminal tabs ("终端 1"…), keyed by tab id.
   * Derived-on-render ordinals would renumber every remaining tab whenever one
   * in the middle was closed, so names are assigned once at creation.
   */
  terminalNames: Record<string, string>
}

interface SidePanelState extends Persisted {
  /** Active session ID associated with current side panel state. */
  currentSessionId: string | null
  /** Map of sessionId -> panel snapshot to ensure right panel state is 100% session-isolated. */
  sessionPanels: Record<string, SessionPanelSnapshot>
  /** Active file and diff payload displayed in the editor tab. */
  activeEditor: ActiveEditorPayload | null
  /** Counter incremented when a panel requests to be explicitly revealed/expanded. */
  revealSignal: number
  /** Switches session context in side panel, restoring session's editor/tabs or clearing them. */
  switchSession: (sessionId: string | null) => void
  /** Opens `id` if it isn't open yet, focuses it, and signals container to un-collapse. */
  openAndRevealSidePanel: (id: SidePanelTabId) => void
  /** Opens the Code Editor panel with the given file diff payload and expands the right column. */
  openEditor: (payload: ActiveEditorPayload) => void
  /** Opens `id` if it isn't open yet, and focuses it either way. */
  openTab: (id: SidePanelTabId) => void
  /** Open a new terminal tab (multiple instances allowed). */
  openTerminalTab: () => void
  /**
   * Closes `id`. When it was the focused tab, focus moves to its left
   * neighbour — the position the eye is already resting on — falling back to
   * the right neighbour for the first tab, and to the picker when nothing is
   * left.
   */
  closeTab: (id: SidePanelTabId) => void
  setActive: (id: SidePanelTabId) => void
}

/**
 * First run opens nothing.
 *
 * A default tab would have to guess, and the guess is wrong in the common case:
 * a fresh install has no workspace, so `files` would greet the user with an
 * empty tree. Showing the picker instead makes the first frame a list of what
 * this column can do, which is the more useful answer to "what is this?".
 */
const DEFAULTS: Persisted = { openTabs: [], activeTab: null, terminalNames: {} }

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Persisted>
    // Filter against ALL_TABS rather than trusting the blob: a stored id from a
    // removed panel (this is how `offpeak` left) would otherwise render a tab
    // whose content component no longer exists.
    const openTabs = Array.isArray(parsed.openTabs)
      ? parsed.openTabs
        .map((x) => String(x))
        .filter((x) => isStaticTabId(x) || isTerminalTabId(x))
        .map(normalizeTabId)
      : []
    const active = parsed.activeTab
    // Drop names whose tab no longer exists, so the record cannot grow forever.
    const terminalNames: Record<string, string> = {}
    const parsedNames = parsed.terminalNames
    if (parsedNames && typeof parsedNames === 'object') {
      for (const [id, name] of Object.entries(parsedNames)) {
        if (typeof name === 'string' && openTabs.includes(id as SidePanelTabId)) {
          terminalNames[id] = name
        }
      }
    }
    return {
      openTabs,
      terminalNames,
      activeTab: active && openTabs.includes(active) ? active : (openTabs[0] ?? null),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Names ride along from the store so every caller doesn't have to thread them. */
function persist(state: Omit<Persisted, 'terminalNames'>) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...state, terminalNames: useSidePanelStore.getState().terminalNames }),
    )
  } catch {
    /* ignore quota */
  }
}

export const useSidePanelStore = create<SidePanelState>((set, get) => ({
  ...load(),
  currentSessionId: null,
  sessionPanels: {},
  activeEditor: null,
  revealSignal: 0,

  switchSession: (newSid) => {
    const { currentSessionId, sessionPanels, openTabs, activeTab, activeEditor } = get()
    if (currentSessionId === newSid && newSid !== null) return

    const nextPanels: Record<string, SessionPanelSnapshot> = { ...sessionPanels }
    if (currentSessionId) {
      // Save state for previous session
      nextPanels[currentSessionId] = {
        openTabs: [...openTabs],
        activeTab,
        activeEditor,
      }
    }

    if (newSid && nextPanels[newSid]) {
      // Restore existing session's side panel state
      const target = nextPanels[newSid]
      set({
        currentSessionId: newSid,
        sessionPanels: nextPanels,
        openTabs: target.openTabs,
        activeTab: target.activeTab,
        activeEditor: target.activeEditor,
      })
    } else {
      // Target session has no recorded panel state (e.g. brand new session or clean switch)
      // Keep global tabs (files, git, browser, etc.) if any, but clean out session-specific tabs (editor, session_learning)
      const cleanTabs: SidePanelTabId[] = openTabs.filter((t) => t !== 'editor' && t !== 'session_learning')
      const nextActive = (activeTab === 'editor' || activeTab === 'session_learning')
        ? (cleanTabs[0] ?? null)
        : (activeTab && (cleanTabs as readonly (SidePanelTabId | null)[]).includes(activeTab) ? activeTab : (cleanTabs[0] ?? null))

      set({
        currentSessionId: newSid,
        sessionPanels: nextPanels,
        openTabs: cleanTabs,
        activeTab: nextActive,
        activeEditor: null,
      })
    }
  },

  openEditor: (payload) => {
    const { openTabs, revealSignal, currentSessionId, sessionPanels } = get()
    const next = openTabs.includes('editor') ? openTabs : [...openTabs, 'editor' as SidePanelTabId]
    const nextPanels = { ...sessionPanels }
    if (currentSessionId) {
      nextPanels[currentSessionId] = {
        openTabs: next,
        activeTab: 'editor',
        activeEditor: payload,
      }
    }
    set({
      activeEditor: payload,
      openTabs: next,
      activeTab: 'editor',
      revealSignal: revealSignal + 1,
      sessionPanels: nextPanels,
    })
    persist({ openTabs: next, activeTab: 'editor' })
  },

  openAndRevealSidePanel: (id) => {
    if (id === 'terminal') {
      get().openTerminalTab()
      set((s) => ({ revealSignal: s.revealSignal + 1 }))
      return
    }
    const { openTabs, revealSignal, currentSessionId, sessionPanels, activeEditor } = get()
    const next = openTabs.includes(id) ? openTabs : [...openTabs, id]
    const nextPanels = { ...sessionPanels }
    if (currentSessionId) {
      nextPanels[currentSessionId] = {
        openTabs: next,
        activeTab: id,
        activeEditor,
      }
    }
    set({ openTabs: next, activeTab: id, revealSignal: revealSignal + 1, sessionPanels: nextPanels })
    persist({ openTabs: next, activeTab: id })
  },

  openTab: (id) => {
    if (id === 'terminal') {
      get().openTerminalTab()
      return
    }
    const { openTabs, currentSessionId, sessionPanels, activeEditor } = get()
    const next = openTabs.includes(id) ? openTabs : [...openTabs, id]
    const nextPanels = { ...sessionPanels }
    if (currentSessionId) {
      nextPanels[currentSessionId] = {
        openTabs: next,
        activeTab: id,
        activeEditor,
      }
    }
    set({ openTabs: next, activeTab: id, sessionPanels: nextPanels })
    persist({ openTabs: next, activeTab: id })
  },

  openTerminalTab: () => {
    const id = newTerminalTabId()
    const { openTabs, terminalNames, revealSignal, currentSessionId, sessionPanels, activeEditor } = get()
    // 稳定命名：序号在创建时定死并持久化。若按渲染位置推导，关闭中间一个
    // 终端会让后面所有终端集体改名，用户对不上哪个是哪个。
    const nextOrdinal = Object.values(terminalNames).reduce((max, name) => {
      const m = name.match(/(\d+)\s*$/)
      return m ? Math.max(max, parseInt(m[1], 10)) : max
    }, 0) + 1
    const nextNames = { ...terminalNames, [id]: `终端 ${nextOrdinal}` }
    const next = [...openTabs, id]
    const nextPanels = { ...sessionPanels }
    if (currentSessionId) {
      nextPanels[currentSessionId] = {
        openTabs: next,
        activeTab: id,
        activeEditor,
      }
    }
    set({ openTabs: next, activeTab: id, terminalNames: nextNames, revealSignal: revealSignal + 1, sessionPanels: nextPanels })
    persist({ openTabs: next, activeTab: id })
  },

  closeTab: (id) => {
    const { openTabs, activeTab, terminalNames, currentSessionId, sessionPanels, activeEditor } = get()
    const idx = openTabs.indexOf(id)
    if (idx === -1) return
    if (isTerminalTabId(id) && window.electronAPI?.isElectron) {
      void window.electronAPI.invoke('terminal:destroy', terminalSessionId(id))
    }
    const next = openTabs.filter((x) => x !== id)
    const nextActive =
      activeTab === id ? (next[idx - 1] ?? next[idx] ?? next[0] ?? null) : activeTab
    const nextPanels = { ...sessionPanels }
    const updatedEditor = id === 'editor' ? null : activeEditor
    // 终端名随 tab 一起销毁，避免 localStorage 里的名字记录无限增长
    const nextNames = { ...terminalNames }
    if (isTerminalTabId(id)) delete nextNames[id]
    if (currentSessionId) {
      nextPanels[currentSessionId] = {
        openTabs: next,
        activeTab: nextActive,
        activeEditor: updatedEditor,
      }
    }
    set({
      openTabs: next,
      activeTab: nextActive,
      activeEditor: updatedEditor,
      terminalNames: nextNames,
      sessionPanels: nextPanels,
    })
    persist({ openTabs: next, activeTab: nextActive })
  },

  setActive: (id) => {
    const { currentSessionId, sessionPanels, openTabs, activeEditor } = get()
    const nextPanels = { ...sessionPanels }
    if (currentSessionId) {
      nextPanels[currentSessionId] = {
        openTabs,
        activeTab: id,
        activeEditor,
      }
    }
    set({ activeTab: id, sessionPanels: nextPanels })
    persist({ openTabs: get().openTabs, activeTab: id })
  },
}))

/**
 * Safely opens a file in pure read-only code viewer mode.
 * Fetches real content from disk via Electron file:readText, respecting scopedPath security sandbox.
 */
export async function openReadOnlyFileViewer(
  filePath: string,
  filename?: string,
  startLine = 1,
  action = 'Inspected',
  fallbackContent?: string,
) {
  let clean = filePath.trim()
  if (clean.startsWith('file://')) clean = clean.replace(/^file:\/\//, '')
  clean = clean.split('#')[0]
  try { clean = decodeURIComponent(clean) } catch {}
  clean = clean.replace(/^\/([a-zA-Z]:)/, '$1')

  const fn = filename || clean.split(/[\/\\]/).pop() || clean
  let content = fallbackContent || ''
  let fileNotFound = false

  const activeWorkspace = useSessionListStore.getState().activeWorkspace

  if (window.electronAPI?.invoke) {
    let res: unknown = null
    try {
      res = await window.electronAPI.invoke('file:readText', clean)
    } catch {
      if (activeWorkspace && !clean.startsWith('/') && !/^[a-zA-Z]:/.test(clean)) {
        const sep = activeWorkspace.includes('\\') ? '\\' : '/'
        const cleanWs = activeWorkspace.replace(/[\\\/]+$/, '')
        const cleanPath = clean.replace(/^[\\\/]+/, '')
        const joined = `${cleanWs}${sep}${cleanPath}`
        try {
          res = await window.electronAPI.invoke('file:readText', joined)
        } catch (e) {
          console.warn('[fileViewer] file:readText failed for', joined, e)
        }
      }
    }

    if (typeof res === 'string') {
      content = res
    } else if (!fallbackContent) {
      fileNotFound = true
    }
  }

  useSidePanelStore.getState().openEditor({
    filePath: clean,
    filename: fn,
    content,
    startLine,
    action,
    readOnly: true,
    fileNotFound,
  })
}

