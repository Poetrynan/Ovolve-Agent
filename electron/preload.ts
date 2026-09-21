// OvolveAgent Electron Preload Script
// Exposes typed IPC bridge to the renderer via contextBridge.
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

type Listener = (...args: any[]) => void

const ALLOWED_EVENT_CHANNELS = new Set<string>([
  'window:state',
  'file:watch:event',
  'browser:state',
  'model:update',
  'app:new-session',
  'app:notify-click',
  'app:open-settings',
  'evolution:proposal',
])

const ALLOWED_INVOKE_PREFIXES = [
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
  'session:',
  'evolution:',
  'mcp:',
  'search:',
]

function isAllowedInvoke(channel: string): boolean {
  return ALLOWED_INVOKE_PREFIXES.some((p) => channel.startsWith(p))
}

const electronAPI = {
  platform: process.platform,
  isElectron: true,

  invoke: (channel: string, ...args: any[]): Promise<any> => {
    if (!isAllowedInvoke(channel)) {
      return Promise.reject(new Error(`[preload] blocked invoke channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  on: (channel: string, cb: Listener): (() => void) => {
    if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
      console.warn(`[preload] blocked event subscription: ${channel}`)
      return () => {}
    }
    const wrapped = (_evt: IpcRendererEvent, ...args: any[]) => cb(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
}

// Convenience namespace matching both ElectronAPI and OvolveDesktopAPI
const ovolveDesktopAPI = {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  openExternal: (url: string) => ipcRenderer.invoke('system:openExternal', url),
  selectFolder: () => ipcRenderer.invoke('workspace:addFolder').then((res: any) => res?.path || null),
  file: {
    readText: (path: string) => ipcRenderer.invoke('file:readText', path),
    writeText: (path: string, content: string) => ipcRenderer.invoke('file:writeText', path, content),
    listDir: (dir: string, showHidden?: boolean) => ipcRenderer.invoke('file:listDir', dir, showHidden),
    stat: (path: string) => ipcRenderer.invoke('file:stat', path),
    exists: (path: string) => ipcRenderer.invoke('file:exists', path),
    search: (root: string, query: string, limit?: number) => ipcRenderer.invoke('file:search', root, query, limit),
    pickDirectory: () => ipcRenderer.invoke('file:pickDirectory'),
    pickFile: (filters?: any) => ipcRenderer.invoke('file:pickFile', filters),
  },
  git: {
    run: (cwd: string, args: string[]) => ipcRenderer.invoke('git:run', cwd, args),
    status: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
    branches: (cwd: string) => ipcRenderer.invoke('git:branches', cwd),
    log: (cwd: string, limit?: number) => ipcRenderer.invoke('git:log', cwd, limit),
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
    merge: (patch: any) => ipcRenderer.invoke('settings:merge', patch),
  },
  model: {
    listProviders: () => ipcRenderer.invoke('model:listProviders'),
    saveProvider: (id: string, patch: any) => ipcRenderer.invoke('model:saveProvider', id, patch),
    deleteProvider: (id: string) => ipcRenderer.invoke('model:deleteProvider', id),
    testConnection: (id: string) => ipcRenderer.invoke('model:testConnection', id),
    revealKey: (id: string) => ipcRenderer.invoke('model:revealKey', id),
    catalog: () => ipcRenderer.invoke('model:catalog'),
    encryptionAvailable: () => ipcRenderer.invoke('model:encryptionAvailable'),
  },
  system: {
    info: () => ipcRenderer.invoke('system:info'),
    openExternal: (url: string) => ipcRenderer.invoke('system:openExternal', url),
    showInFolder: (path: string) => ipcRenderer.invoke('system:showInFolder', path),
    openPath: (path: string) => ipcRenderer.invoke('system:openPath', path),
    notify: (opts: any) => ipcRenderer.invoke('system:notify', opts),
  },
  workspace: {
    openNewWindow: (path: string) => ipcRenderer.invoke('workspace:openNewWindow', path),
    addFolder: () => ipcRenderer.invoke('workspace:addFolder'),
    revealInExplorer: (path: string) => ipcRenderer.invoke('workspace:revealInExplorer', path),
  },
  tray: {
    setCloseToTray: (v: boolean) => ipcRenderer.invoke('tray:setCloseToTray', v),
    getCloseToTray: () => ipcRenderer.invoke('tray:getCloseToTray'),
    hideWindow: () => ipcRenderer.invoke('tray:hideWindow'),
    quit: () => ipcRenderer.invoke('tray:quit'),
  },
  session: {
    load: () => ipcRenderer.invoke('session:load'),
    save: (data: { sessions: any[]; activeSessionId: string | null }) => ipcRenderer.invoke('session:save', data),
  },
  evolution: {
    getMode: (workspaceRoot?: string) => ipcRenderer.invoke('evolution:mode', workspaceRoot),
    setMode: (mode: string, workspaceRoot?: string) => ipcRenderer.invoke('evolution:setMode', mode, workspaceRoot),
    getProposals: (workspaceRoot?: string) => ipcRenderer.invoke('evolution:proposals', workspaceRoot),
    accept: (id: string, workspaceRoot?: string) => ipcRenderer.invoke('evolution:accept', id, workspaceRoot),
    reject: (id: string, workspaceRoot?: string) => ipcRenderer.invoke('evolution:reject', id, workspaceRoot),
    recordSignal: (payload: any, workspaceRoot?: string) => ipcRenderer.invoke('evolution:recordSignal', payload, workspaceRoot),
    rulesPrompt: (workspaceRoot?: string) => ipcRenderer.invoke('evolution:rulesPrompt', workspaceRoot),
  },
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:listServers'),
    addServer: (config: any) => ipcRenderer.invoke('mcp:addServer', config),
    listTools: () => ipcRenderer.invoke('mcp:listTools'),
    callTool: (serverId: string, toolName: string, args: any) => ipcRenderer.invoke('mcp:callTool', serverId, toolName, args),
  },
  search: {
    grep: (root: string, pattern: string, glob?: string) => ipcRenderer.invoke('search:grep', root, pattern, glob),
    glob: (root: string, pattern: string) => ipcRenderer.invoke('search:glob', root, pattern),
  },
  terminal: {
    run: (cwd: string, command: string, timeoutMs?: number) => ipcRenderer.invoke('terminal:run', cwd, command, timeoutMs),
  },
  invoke: (channel: string, ...args: any[]) => {
    if (!isAllowedInvoke(channel)) return Promise.reject(new Error(`blocked: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
contextBridge.exposeInMainWorld('ovolveDesktopAPI', ovolveDesktopAPI)
