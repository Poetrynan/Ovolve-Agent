// src/types/electron.d.ts
// Ambient declaration for the preload bridge (see electron/preload.ts).
export interface ElectronBridge {
  platform: string
  isElectron: boolean
  /** RPC to the main process. Rejects on non-whitelisted channels. */
  invoke: (channel: string, ...args: any[]) => Promise<any>
  /** Subscribe to a broadcast channel; returns an unsubscribe function. */
  on: (channel: string, cb: (...args: any[]) => void) => () => void
}

declare global {
  interface Window {
    electronAPI?: ElectronBridge
  }
}
