import React from 'react'
import { X, Sliders, Cpu, Settings } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { ModelConfigTab } from './ModelConfigTab'
import { GeneralTab } from './GeneralTab'

export const SettingsModal: React.FC = () => {
  const isSettingsOpen = useAgentStore((s) => s.isSettingsOpen)
  const toggleSettings = useAgentStore((s) => s.toggleSettings)

  return (
    <Dialog open={isSettingsOpen} onOpenChange={toggleSettings}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col p-0 gap-0 border-border/80 dark:border-white/12 bg-card/95 dark:bg-[#111319]/95 backdrop-blur-2xl">
        {/* Header */}
        <DialogHeader className="p-4 border-b border-border/70 dark:border-white/10 flex flex-row items-center justify-between space-y-0 select-none">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary/15 text-primary">
              <Sliders size={15} />
            </div>
            <DialogTitle className="text-sm font-semibold text-foreground">
              OvolveAgent Settings
            </DialogTitle>
          </div>
        </DialogHeader>

        {/* Content Tabs */}
        <div className="p-5 overflow-y-auto flex-1">
          <Tabs defaultValue="models" className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-4">
              <TabsTrigger value="models" className="flex items-center gap-2 text-xs">
                <Cpu size={13} />
                <span>Models & Providers</span>
              </TabsTrigger>
              <TabsTrigger value="general" className="flex items-center gap-2 text-xs">
                <Settings size={13} />
                <span>General & Desktop</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="models" className="mt-0">
              <ModelConfigTab />
            </TabsContent>

            <TabsContent value="general" className="mt-0">
              <GeneralTab />
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default SettingsModal
