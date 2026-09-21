import { create } from 'zustand'

const STORAGE_KEY = 'ovolve-tray-prefs'
// Pre-rename key, still read so existing users keep their close-button choice.
const LEGACY_STORAGE_KEY = 'ovolve-tray-prefs'

export interface TrayPrefs {
  /**
   * When true, clicking the window's close button hides Ovolve to the system
   * tray instead of quitting — background turns, bots and schedulers keep
   * running. When false, closing the window quits the app outright.
   */
  closeToTray: boolean
}

interface TrayPrefsState extends TrayPrefs {
  setCloseToTray: (v: boolean) => void
}

// Hide-to-tray by default: for an agent app, an accidental window close should
// never silently kill an in-flight run. Mirrors the main-process default in
// electron/tray.ts.
const DEFAULTS: TrayPrefs = { closeToTray: true }

function load(): TrayPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    return { closeToTray: parsed.closeToTray !== false }
  } catch {
    return { ...DEFAULTS }
  }
}

function persist(prefs: TrayPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore quota */
  }
}

/** Push the value to the Electron main process, which owns the close handler. */
function syncToMain(closeToTray: boolean) {
  const api = (window as any)?.electronAPI
  if (api?.isElectron && typeof api.invoke === 'function') {
    api.invoke('tray:setCloseToTray', closeToTray).catch(() => {})
  }
}

export const useTrayPrefsStore = create<TrayPrefsState>((set, get) => {
  const initial = load()
  // Main defaults to hide-on-close on a fresh boot; push the persisted value
  // once at store creation so a user who turned it off doesn't get a
  // hide-to-tray surprise on the first close after relaunch.
  syncToMain(initial.closeToTray)
  return {
    ...initial,
    setCloseToTray: (closeToTray) => {
      set({ closeToTray })
      persist({ ...get(), closeToTray })
      syncToMain(closeToTray)
    },
  }
})
