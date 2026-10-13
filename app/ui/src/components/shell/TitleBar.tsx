// src/components/shell/TitleBar.tsx
// Custom frameless title bar — draggable region + window controls.
// macOS: native traffic lights are positioned by `titleBarStyle: 'hiddenInset'`
// so we only show our own buttons on Windows/Linux.
import { useEffect, useState } from 'react'
import { Minus, Square, X, Maximize2 } from 'lucide-react'
import { cn } from '@lib/utils'

const isMac = window.electronAPI?.platform === 'darwin'

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const unsub = window.electronAPI?.on('window:state', (state: any) => {
      setMaximized(!!state?.maximized)
    })
    // Check initial state
    void window.electronAPI?.invoke('window:isMaximized').then((v) => setMaximized(!!v))
    return () => { unsub?.() }
  }, [])

  const handleMin = () => window.electronAPI?.invoke('window:minimize')
  const handleMax = () => window.electronAPI?.invoke('window:toggleMaximize')
  const handleClose = () => window.electronAPI?.invoke('window:close')

  return (
    <div
      className={cn(
        'flex items-center h-9 shrink-0 select-none border-b border-border/30',
        'bg-background/50 backdrop-blur-xl z-20',
        // Entire bar is draggable — buttons opt out via no-drag
        '[-webkit-app-region:drag]',
      )}
    >
      {/* macOS: leave space for native traffic lights (≈70px) */}
      {isMac && <div className="w-[70px] shrink-0" />}

      {/* Windows/Linux: App title without icon */}
      {!isMac && (
        <div className="flex items-center pl-3.5 shrink-0">
          <span className="text-[11px] font-semibold text-foreground/70 tracking-tight">Ovolve</span>
        </div>
      )}

      {/* Centre stays empty on purpose. It held a static "AI Work Browser"
          caption, which named the product a second time (the icon and "Ovolve"
          are already on the left) and never changed. The spacer itself is still
          needed: it keeps the window controls on the right edge and leaves the
          middle of the bar as draggable surface. */}
      <div className="flex-1" />


      {/* Windows/Linux: custom window controls */}
      {!isMac && (
        <div className="flex items-center shrink-0 [-webkit-app-region:no-drag]">
          <button
            onClick={handleMin}
            className="inline-flex items-center justify-center w-11 h-9 text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
            aria-label="最小化"
          >
            <Minus size={14} />
          </button>
          <button
            onClick={handleMax}
            className="inline-flex items-center justify-center w-11 h-9 text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
            aria-label={maximized ? '还原' : '最大化'}
          >
            {maximized ? <Square size={12} /> : <Maximize2 size={13} />}
          </button>
          <button
            onClick={handleClose}
            className="inline-flex items-center justify-center w-11 h-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
