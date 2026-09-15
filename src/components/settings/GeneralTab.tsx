import React, { useState, useEffect } from 'react'
import { Monitor, Moon, Sun, FolderOpen, Shield, Laptop, Check } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'

export const GeneralTab: React.FC = () => {
  const theme = useAgentStore((s) => s.theme)
  const setTheme = useAgentStore((s) => s.setTheme)
  const workspaceRoot = useAgentStore((s) => s.workspaceRoot)
  const setWorkspaceRoot = useAgentStore((s) => s.setWorkspaceRoot)

  const [closeToTray, setCloseToTray] = useState(true)
  const [systemInfo, setSystemInfo] = useState<any>(null)
  const [savedSuccess, setSavedSuccess] = useState(false)

  useEffect(() => {
    const load = async () => {
      if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.tray?.getCloseToTray) {
        try {
          const res = await (window as any).ovolveDesktopAPI.tray.getCloseToTray()
          if (res?.ok) setCloseToTray(res.closeToTray)
        } catch (_) {}
      }

      if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.system?.info) {
        try {
          const info = await (window as any).ovolveDesktopAPI.system.info()
          setSystemInfo(info)
        } catch (_) {}
      }
    }
    load()
  }, [])

  const handleToggleCloseToTray = async (v: boolean) => {
    setCloseToTray(v)
    if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.tray?.setCloseToTray) {
      await (window as any).ovolveDesktopAPI.tray.setCloseToTray(v)
    }
    setSavedSuccess(true)
    setTimeout(() => setSavedSuccess(false), 1500)
  }

  const handlePickWorkspace = async () => {
    if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.selectFolder) {
      const folder = await (window as any).ovolveDesktopAPI.selectFolder()
      if (folder) {
        setWorkspaceRoot(folder)
        setSavedSuccess(true)
        setTimeout(() => setSavedSuccess(false), 1500)
      }
    }
  }

  return (
    <div className="space-y-4 text-xs">
      {/* Theme Appearance */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
          Appearance & Aesthetic
        </label>

        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => setTheme('dark')}
            className={`p-3 rounded-xl border flex items-center gap-3 transition-all cursor-pointer ${
              theme === 'dark'
                ? 'bg-primary/10 border-primary text-foreground ring-1 ring-primary/40'
                : 'bg-muted/30 border-border/70 dark:border-white/5 text-muted-foreground hover:bg-muted/60'
            }`}
          >
            <div className="p-2 rounded-lg bg-indigo-500/20 text-indigo-400">
              <Moon size={16} />
            </div>
            <div className="text-left">
              <div className="font-semibold text-foreground">Cosmic Onyx</div>
              <div className="text-[10.5px] text-muted-foreground">Fluid Aura + 24px Glass</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setTheme('light')}
            className={`p-3 rounded-xl border flex items-center gap-3 transition-all cursor-pointer ${
              theme === 'light'
                ? 'bg-primary/10 border-primary text-foreground ring-1 ring-primary/40'
                : 'bg-muted/30 border-border/70 dark:border-white/5 text-muted-foreground hover:bg-muted/60'
            }`}
          >
            <div className="p-2 rounded-lg bg-amber-500/20 text-amber-500">
              <Sun size={16} />
            </div>
            <div className="text-left">
              <div className="font-semibold text-foreground">Pure Canvas Light</div>
              <div className="text-[10.5px] text-muted-foreground">Tactile Micro-Borders</div>
            </div>
          </button>
        </div>
      </div>

      {/* Desktop Window & Tray Behavior */}
      <div className="space-y-2 pt-2 border-t border-border/60 dark:border-white/5">
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
          Desktop Application Behavior
        </label>

        <div className="p-3 rounded-xl border border-border/70 dark:border-white/10 bg-muted/20 dark:bg-white/[0.02] flex items-center justify-between">
          <div className="space-y-0.5">
            <div className="font-medium text-foreground">Minimize to System Tray on Close</div>
            <div className="text-[11px] text-muted-foreground">
              Keep background agents & schedulers running in tray when clicking window close (X)
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleToggleCloseToTray(!closeToTray)}
            className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer p-0.5 ${
              closeToTray ? 'bg-primary' : 'bg-muted-foreground/30'
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white shadow-md transition-transform ${
                closeToTray ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Default Workspace Root */}
      <div className="space-y-2 pt-2 border-t border-border/60 dark:border-white/5">
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
          Default Workspace Directory
        </label>

        <div className="flex items-center gap-2">
          <div className="flex-1 px-3 py-2 rounded-lg bg-muted/40 dark:bg-white/[0.03] border border-border/70 dark:border-white/10 font-mono text-xs text-foreground truncate">
            {workspaceRoot || 'No workspace directory selected'}
          </div>
          <button
            type="button"
            onClick={handlePickWorkspace}
            className="px-3 py-2 rounded-lg border border-border/80 dark:border-white/10 bg-background/80 hover:bg-muted text-foreground flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
          >
            <FolderOpen size={13} className="text-primary" />
            <span>Select Folder...</span>
          </button>
        </div>
      </div>

      {/* System Information */}
      {systemInfo && (
        <div className="space-y-2 pt-2 border-t border-border/60 dark:border-white/5">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
            System & Runtime Diagnostics
          </label>

          <div className="p-3 rounded-xl border border-border/70 dark:border-white/10 bg-muted/20 dark:bg-white/[0.02] grid grid-cols-2 gap-2 text-[11px] font-mono text-muted-foreground">
            <div>Platform: <span className="text-foreground">{systemInfo.platform} ({systemInfo.arch})</span></div>
            <div>OvolveAgent Version: <span className="text-foreground">{systemInfo.appVersion || '1.0.0'}</span></div>
            <div>Electron: <span className="text-foreground">v{systemInfo.electron}</span></div>
            <div>Node.js: <span className="text-foreground">v{systemInfo.node}</span></div>
            <div>Chrome: <span className="text-foreground">v{systemInfo.chrome}</span></div>
            <div>Hostname: <span className="text-foreground">{systemInfo.hostname}</span></div>
          </div>
        </div>
      )}
    </div>
  )
}

export default GeneralTab
