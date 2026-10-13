// electron/ipc/index.ts
// Central IPC registrar. Wires every domain-specific handler group.
import { BrowserWindow } from 'electron'
import { registerFileHandlers } from './fileHandlers'
import { registerGitHandlers } from './gitHandlers'
import { registerSettingsHandlers } from './settingsHandlers'
import { registerModelHandlers } from './modelHandlers'
import { registerBrowserHandlers } from './browserHandlers'
import { registerSystemHandlers } from './systemHandlers'
import { registerWindowHandlers } from './windowHandlers'
import { registerWorkspaceHandlers } from './workspaceHandlers'
import { registerTrayHandlers } from './trayHandlers'
import { registerTerminalHandlers } from './terminalHandlers'

export interface IPCContext {
  getMainWindow: () => BrowserWindow | null
  /** Root directory containing config.json / setting.json. */
  configRoot: string
  /** Shared secret for the 127.0.0.1:8766 browser control bridge, which
   *  rejects unauthenticated callers. Owned by BrowserManager. */
  bridgeToken?: string
  /** Open a second app window pointed at the given workspace folder.
   *  Provided by main.ts (which owns createWindow); optional so tests and
   *  headless contexts can register handlers without a window factory. */
  openWorkspaceWindow?: (workspacePath: string) => BrowserWindow
}

export function registerAllIpc(ctx: IPCContext) {
  registerFileHandlers(ctx)
  registerGitHandlers(ctx)
  registerSettingsHandlers(ctx)
  registerModelHandlers(ctx)
  registerBrowserHandlers(ctx)
  registerSystemHandlers(ctx)
  registerWindowHandlers(ctx)
  registerWorkspaceHandlers(ctx)
  registerTrayHandlers(ctx)
  registerTerminalHandlers(ctx)
  console.log('[ipc] all channels registered')
}
