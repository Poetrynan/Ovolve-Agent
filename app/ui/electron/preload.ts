// Ovolve Electron Preload Script
// ------------------------------------------------------------------
// Exposes a typed IPC bridge to the renderer via contextBridge.
// The renderer talks to the main process through `window.electronAPI`.
// Channels are namespaced: file:*, git:*, settings:*, model:*, browser:*,
// memory:*, terminal:*, system:*, window:*.
// ------------------------------------------------------------------
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

type Listener = (...args: any[]) => void

// Whitelist of channels the renderer is allowed to subscribe to.
// Anything not in this list is rejected — standard IPC hygiene.
const ALLOWED_EVENT_CHANNELS = new Set<string>([
  'window:state',
  'file:watch:event',
  'browser:state',
  'browser:navigate',
  'model:update',
  // PTY 输出流。漏掉这条时终端面板从建立之初就是黑的：terminal:create 能
  // 正常创建会话、按键也能写入，但回显被这里的白名单静默拦截，xterm 永远
  // 收不到任何输出。
  'terminal:data',
  // Keyboard accelerators the main process owns (⌘N is swallowed by Chromium
  // before the renderer ever sees a keydown, so it has to arrive as an event).
  'app:new-session',
  // Native notification click — carries { sessionId } so the renderer can switch.
  'app:notify-click',
  // Tray menu → jump to Settings inside the renderer.
  'app:open-settings',
])

// Whitelist of invoke channels for defence-in-depth. `invoke` is a request/
// response call — even so we enforce a namespace prefix so a compromised
// renderer cannot poke arbitrary main-process handlers.
const ALLOWED_INVOKE_PREFIXES = [
  // `app:` carries the local API token handed to the renderer (app:getApiToken).
  // It is a read of a secret the renderer needs in order to talk to the backend
  // at all, so it is exposed here rather than embedded at build time.
  'app:',
  'file:',
  'git:',
  'settings:',
  'model:',
  'browser:',
  'memory:',
  'terminal:',
  'system:',
  'window:',
  'workspace:',
  'tray:',
]

function isAllowedInvoke(channel: string): boolean {
  return ALLOWED_INVOKE_PREFIXES.some((p) => channel.startsWith(p))
}

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,

  /** Fire-and-await RPC to the main process. Throws on unknown channels. */
  invoke: (channel: string, ...args: any[]): Promise<any> => {
    if (!isAllowedInvoke(channel)) {
      return Promise.reject(new Error(`[preload] blocked invoke channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  /** Subscribe to a broadcast event. Returns an unsubscribe function. */
  on: (channel: string, cb: Listener): (() => void) => {
    if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
      console.warn(`[preload] blocked event subscription: ${channel}`)
      return () => {}
    }
    const wrapped = (_evt: IpcRendererEvent, ...args: any[]) => cb(...args)
    ipcRenderer.on(channel, wrapped)
    // Unsubscribe via the returned closure — the raw `cb` is not the registered
    // listener (it is wrapped to strip the IpcRendererEvent), so there is
    // deliberately no `off(channel, cb)` counterpart.
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
})
