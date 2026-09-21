import { create } from 'zustand'
import type { GitStatus } from '@apptypes/index'
import {
  checkoutBranch,
  commitChanges,
  createAndCheckoutBranch,
  fetchGitBranches,
  fetchGitStatus,
  pushBranch,
  restoreGitChanges,
  type CommitResult,
} from '@lib/gitApi'
import { useAgentStore } from '@store/agentStore'

interface GitState {
  status: GitStatus | null
  branches: string[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  restore: (paths?: string[]) => Promise<void>
  checkout: (branch: string) => Promise<void>
  createAndCheckout: (name: string) => Promise<void>
  /** Commit from the panel. Empty message → backend drafts one with `model`. */
  commit: (opts: { message: string; includeUnstaged: boolean; push: boolean; model?: string }) => Promise<CommitResult>
  push: () => Promise<void>
}

export const useGitStore = create<GitState>((set, get) => ({
  status: null,
  branches: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const [status, branchInfo] = await Promise.all([
        fetchGitStatus(),
        fetchGitBranches().catch(() => ({ current: '', branches: [] as string[] })),
      ])
      set({
        status,
        branches: branchInfo.branches,
        loading: false,
      })
    } catch (e: any) {
      set({ loading: false, error: e?.message || '无法读取 Git 状态' })
    }
  },

  restore: async (paths) => {
    await restoreGitChanges(paths)
    await get().refresh()
  },

  checkout: async (branch) => {
    await checkoutBranch(branch)
    await get().refresh()
  },

  createAndCheckout: async (name) => {
    await createAndCheckoutBranch(name)
    await get().refresh()
  },

  commit: async (opts) => {
    const result = await commitChanges(opts)
    // Refresh even when the push half failed — the commit landed, so the panel
    // must stop showing those files as uncommitted.
    await get().refresh()
    return result
  },

  push: async () => {
    await pushBranch()
    await get().refresh()
  },
}))

// Re-fetch git state immediately whenever the visible session changes — in a
// multi-window setup each window has its own session/workspace, so the panel
// must swap in step with the switch instead of waiting for the 12s poll tick.
// Guard on actual value change to avoid a refresh loop while a `set` inside
// refresh() propagates.
//
// Deliberately NO eager `status: null` clear here. There used to be one, to
// avoid showing a stale branch/change count through the network round-trip, but
// sessions inside one window all share that window's workspace — so the git
// state is IDENTICAL before and after a session switch, and blanking it bought
// nothing. What it cost was a visible jerk in the right-hand panel on every
// switch and every new chat: `status: null` collapsed the change block to the
// 「非 Git 仓库」 placeholder and the branch chip to '…', then ~one round-trip
// later everything expanded back. Three renders (null → loading → resolved) for
// a value that never changed. Now `refresh()` swaps the new status in with a
// single update and the panel simply holds its last known state meanwhile.
let __lastSid = useAgentStore.getState().sessionId
useAgentStore.subscribe((state) => {
  if (state.sessionId !== __lastSid) {
    __lastSid = state.sessionId
    void useGitStore.getState().refresh()
  }
})
