import React, { useState, useEffect } from 'react'
import { Sparkles, Minus, Square, Copy, X, Sliders, Sun, Moon } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'

export const CustomTitlebar: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false)
  const toggleSettings = useAgentStore((s) => s.toggleSettings)
  const theme = useAgentStore((s) => s.theme)
  const setTheme = useAgentStore((s) => s.setTheme)
  const modelConfig = useAgentStore((s) => s.modelConfig)

  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.isMaximized) {
      (window as any).ovolveDesktopAPI.isMaximized().then(setIsMaximized)
    }

    if (typeof window !== 'undefined' && (window as any).electronAPI?.on) {
      const unsub = (window as any).electronAPI.on('window:state', (state: { maximized: boolean }) => {
        setIsMaximized(state.maximized)
      })
      return unsub
    }
  }, [])

  const handleMinimize = () => {
    if ((window as any).ovolveDesktopAPI?.minimize) {
      (window as any).ovolveDesktopAPI.minimize()
    }
  }

  const handleMaximize = () => {
    if ((window as any).ovolveDesktopAPI?.maximize) {
      (window as any).ovolveDesktopAPI.maximize().then((res: any) => {
        if (res && typeof res.maximized === 'boolean') setIsMaximized(res.maximized)
        else setIsMaximized(!isMaximized)
      })
    }
  }

  const handleClose = () => {
    if ((window as any).ovolveDesktopAPI?.close) {
      (window as any).ovolveDesktopAPI.close()
    }
  }

  return (
    <header className="h-9 w-full bg-background/80 dark:bg-[#0d0f14]/80 backdrop-blur-xl border-b border-border/70 dark:border-white/10 flex items-center justify-between px-3 select-none drag-region z-50 shrink-0">
      {/* Left: Brand Icon & Version */}
      <div className="flex items-center gap-2 no-drag">
        <div className="w-5 h-5 rounded-md bg-gradient-to-tr from-cyan-500 via-blue-600 to-indigo-600 flex items-center justify-center shadow-xs">
          <Sparkles size={11} className="text-white" />
        </div>
        <span className="font-semibold text-xs tracking-wider uppercase text-foreground/90 font-heading">
          OvolveAgent
        </span>
        <span className="text-[9.5px] px-1.5 py-0.2 rounded bg-primary/15 text-primary font-mono border border-primary/25">
          v1.0
        </span>
      </div>

      {/* Center: Model Quick Badge */}
      <div className="flex items-center gap-2 no-drag">
        <button
          type="button"
          onClick={() => toggleSettings(true)}
          className="glass-pill px-2.5 py-0.5 rounded-full text-xs text-foreground/80 hover:text-foreground inline-flex items-center gap-1.5 cursor-pointer transition-all"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[11px] font-mono font-medium">{modelConfig.modelName}</span>
          <Sliders size={11} className="text-muted-foreground ml-0.5" />
        </button>
      </div>

      {/* Right: Theme Toggle & Window Controls */}
      <div className="flex items-center gap-1 no-drag">
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="w-7 h-7 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors cursor-pointer mr-1"
          title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
          {theme === 'dark' ? <Moon size={13} className="text-indigo-400" /> : <Sun size={13} className="text-amber-400" />}
        </button>

        <button
          type="button"
          onClick={handleMinimize}
          className="w-7 h-7 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
          title="Minimize"
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          onClick={handleMaximize}
          className="w-7 h-7 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <Copy size={11} className="rotate-180" /> : <Square size={11} />}
        </button>
        <button
          type="button"
          onClick={handleClose}
          className="w-7 h-7 rounded-md hover:bg-rose-500 hover:text-white text-muted-foreground flex items-center justify-center transition-colors cursor-pointer"
          title="Close"
        >
          <X size={13} />
        </button>
      </div>
    </header>
  )
}

export default CustomTitlebar
