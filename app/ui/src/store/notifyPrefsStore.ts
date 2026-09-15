import { create } from 'zustand'

const STORAGE_KEY = 'ovolve-notify-prefs'

export interface NotifyPrefs {
  /** Master switch for OS toasts when a session settles. */
  enabled: boolean
  /**
   * Also toast for the session the user is currently watching in a focused
   * window. Off by default because that toast is pure noise — the result is
   * already on screen. On for users who alt-tab away mid-turn and want the
   * ping regardless of which session was last selected.
   */
  whenFocused: boolean
  /** Toast only for failures, staying quiet on success. */
  failuresOnly: boolean
}

interface NotifyPrefsState extends NotifyPrefs {
  setEnabled: (v: boolean) => void
  setWhenFocused: (v: boolean) => void
  setFailuresOnly: (v: boolean) => void
}

const DEFAULTS: NotifyPrefs = {
  enabled: true,
  whenFocused: false,
  failuresOnly: false,
}

function load(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    return {
      // `!== false` so a partial/older blob keeps the opt-out default,
      // `=== true` so the opt-in ones stay off unless explicitly set.
      enabled: parsed.enabled !== false,
      whenFocused: parsed.whenFocused === true,
      failuresOnly: parsed.failuresOnly === true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function persist(prefs: NotifyPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore quota */
  }
}

export const useNotifyPrefsStore = create<NotifyPrefsState>((set, get) => ({
  ...load(),
  setEnabled: (enabled) => {
    set({ enabled })
    persist({ ...get(), enabled })
  },
  setWhenFocused: (whenFocused) => {
    set({ whenFocused })
    persist({ ...get(), whenFocused })
  },
  setFailuresOnly: (failuresOnly) => {
    set({ failuresOnly })
    persist({ ...get(), failuresOnly })
  },
}))
