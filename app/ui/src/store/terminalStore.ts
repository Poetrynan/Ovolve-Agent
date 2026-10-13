// src/store/terminalStore.ts
// User-facing PTY session + optional mirror of agent shell_executor output.
import { create } from 'zustand'
import { useSidePanelStore, isTerminalTabId, terminalSessionId } from '@store/sidePanelStore'

const USER_TERMINAL_ID = 'ovolve-user-terminal'

interface TerminalState {
  /** Legacy default session id; per-tab ids come from SidePanel. */
  sessionId: string
  /** When true, agent shell commands echo into the focused terminal tab. */
  mirrorAgent: boolean
  workspaceCwd: string | null
  setWorkspaceCwd: (cwd: string | null) => void
  setMirrorAgent: (on: boolean) => void
  /** Ensure PTY exists (idempotent). */
  ensureSession: (cwd: string) => Promise<boolean>
  /** Agent ran a shell command — echo header in user terminal. */
  mirrorCommand: (cwd: string | undefined, command: string) => void
  /** Stream agent command stdout into user terminal. */
  mirrorChunk: (chunk: string) => void
  destroySession: () => Promise<void>
}

const CMD_TOOLS = /^(run_command|shell_executor|bash|shell|exec|terminal|python_executor|run_python)$/i

export function isShellTool(name: string): boolean {
  return CMD_TOOLS.test(name || '')
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessionId: USER_TERMINAL_ID,
  mirrorAgent: true,
  workspaceCwd: null,

  setWorkspaceCwd: (cwd) => set({ workspaceCwd: cwd }),

  setMirrorAgent: (on) => set({ mirrorAgent: on }),

  ensureSession: async (cwd) => {
    const api = window.electronAPI
    if (!api?.isElectron) return false
    const { sessionId } = get()
    try {
      const res = await api.invoke('terminal:create', cwd, sessionId)
      set({ workspaceCwd: cwd })
      return Boolean(res?.ok)
    } catch {
      return false
    }
  },

  mirrorCommand: (cwd, command) => {
    const { mirrorAgent, workspaceCwd } = get()
    if (!mirrorAgent || !window.electronAPI?.isElectron || !command.trim()) return
    const active = useSidePanelStore.getState().activeTab
    const sessionId = active && isTerminalTabId(active)
      ? terminalSessionId(active)
      : get().sessionId
    void window.electronAPI.invoke('terminal:mirror', sessionId, {
      command,
      cwd: cwd || workspaceCwd || undefined,
    })
  },

  mirrorChunk: (chunk) => {
    const { mirrorAgent } = get()
    if (!mirrorAgent || !window.electronAPI?.isElectron || !chunk) return
    const active = useSidePanelStore.getState().activeTab
    const sessionId = active && isTerminalTabId(active)
      ? terminalSessionId(active)
      : get().sessionId
    void window.electronAPI.invoke('terminal:mirror', sessionId, { chunk })
  },

  destroySession: async () => {
    const api = window.electronAPI
    if (!api?.isElectron) return
    try {
      await api.invoke('terminal:destroy', get().sessionId)
    } catch { /* ignore */ }
  },
}))
