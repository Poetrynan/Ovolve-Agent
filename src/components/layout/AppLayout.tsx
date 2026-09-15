import React from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { CustomTitlebar } from './CustomTitlebar'
import { SessionSidebar } from '../sidebar/SessionSidebar'
import { ConversationView } from '../chat/ConversationView'
import { SettingsModal } from '../settings/SettingsModal'
import { FluidAuraBackground } from '../ui/FluidAuraBackground'

export const AppLayout: React.FC = () => {
  return (
    <div className="w-screen h-screen flex flex-col bg-background text-foreground overflow-hidden relative selection:bg-primary/20">
      {/* Ambient Fluid Aura Canvas Layer */}
      <FluidAuraBackground />

      {/* 1. Custom Frameless Titlebar */}
      <CustomTitlebar />

      {/* 2. Resizable Workspace Shell */}
      <div className="flex-1 flex overflow-hidden relative">
        <Group orientation="horizontal" className="h-full w-full">
          {/* Left Session Sidebar Panel */}
          <Panel defaultSize="20%" minSize="15%" maxSize="35%" className="h-full">
            <SessionSidebar />
          </Panel>

          {/* Resizable Sash Divider */}
          <Separator className="w-1 bg-border/40 hover:bg-primary/50 transition-colors cursor-col-resize relative" />

          {/* Main Chat Viewport Panel */}
          <Panel minSize="50%" className="h-full flex flex-col relative overflow-hidden">
            <ConversationView />
          </Panel>
        </Group>
      </div>

      {/* 3. Settings Modal */}
      <SettingsModal />
    </div>
  )
}

export default AppLayout
