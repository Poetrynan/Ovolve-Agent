// src/components/shell/WorkspaceShell.tsx
//
// Frameless outer shell:  [TitleBar]
//                         [Sidebar │ route content]
//
// The `│` is now a real, draggable sash — react-resizable-panels drives the
// widths and `useStoredLayout` remembers them across reloads via localStorage,
// so a user's preferred sidebar width isn't lost when they close the app.
//
// The right-side working panel is still owned by each page (e.g. ChatPage
// runs its own inner PanelGroup for `center │ right`) — this file only cares
// about `left │ main`, keeping the shell agnostic to what any given route
// wants to put on the right.
import { useEffect, useRef, type ReactNode } from 'react'
import TitleBar from './TitleBar'
import { SystemHealthBanner } from '@components/SystemHealthBanner'
import { FluidAuraBackground } from '@components/ui/FluidAuraBackground'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  useStoredLayout,
  type PanelImperativeHandle,
} from '@components/ui/resizable'

interface WorkspaceShellProps {
  sidebar: ReactNode
  sidebarOpen: boolean
  children: ReactNode
}

export default function WorkspaceShell({ sidebar, sidebarOpen, children }: WorkspaceShellProps) {
  // Imperative handle so an external toggle (the ChatPage header button)
  // can collapse/expand the panel without us re-rendering the panel tree.
  // The panel state and the boolean prop are kept in sync via this effect.
  const leftRef = useRef<PanelImperativeHandle | null>(null)
  const { defaultLayout, onLayoutChanged } = useStoredLayout('ovolve-shell-layout')

  useEffect(() => {
    const panel = leftRef.current
    if (!panel) return
    if (sidebarOpen) {
      if (panel.isCollapsed()) panel.expand()
    } else {
      if (!panel.isCollapsed()) panel.collapse()
    }
  }, [sidebarOpen])

  return (
    <div className="relative flex flex-col h-screen bg-background/90 text-foreground overflow-hidden">
      {/* Background Fluid Aura Layer */}
      <FluidAuraBackground />

      <TitleBar />

      {/* 后端自报的降级状态（迁移回滚 / 实例锁不在手里） */}
      <SystemHealthBanner />

      {/* Outer sash: left sidebar ↔ main. */}
      <ResizablePanelGroup
        orientation="horizontal"
        id="ovolve-shell"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="flex-1 min-h-0 relative z-10"
      >
        {/* Left sidebar — collapsible with frosted backdrop */}
        <ResizablePanel
          panelRef={leftRef}
          id="shell-left"
          defaultSize="15%"
          minSize="10%"
          maxSize="30%"
          collapsible
          collapsedSize={0}
          className="border-r border-border/40 bg-sidebar/65 backdrop-blur-2xl shadow-xs data-[panel-collapsed=true]:border-r-0"
        >
          {sidebar}
        </ResizablePanel>

        <ResizableHandle className="hover:bg-primary/40 transition-colors opacity-40 hover:opacity-100" />

        {/* Route content */}
        <ResizablePanel id="shell-main" defaultSize="85%" minSize="40%">
          <main className="h-full w-full min-w-0 min-h-0 flex flex-col overflow-y-scroll [scrollbar-gutter:stable] bg-transparent">
            {children}
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
