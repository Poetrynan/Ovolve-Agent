import React from 'react'
import { FolderOpen, GitBranch, MessageSquare } from 'lucide-react'
import { cn } from '../ui/button'
import { useAgentStore } from '../../store/agentStore'

interface CapsuleProps {
  variant?: 'hero' | 'header'
  className?: string
  onSelectWorkspace?: () => void
}

export const SessionTripartiteCapsule: React.FC<CapsuleProps> = ({
  variant = 'header',
  className = '',
  onSelectWorkspace,
}) => {
  const isHero = variant === 'hero'
  const workspaceRoot = useAgentStore((s) => s.workspaceRoot)
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const setWorkspaceRoot = useAgentStore((s) => s.setWorkspaceRoot)

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const workspaceName = workspaceRoot ? workspaceRoot.split(/[\\/]/).pop() || 'Default' : 'Default'
  const branchName = activeSession?.gitBranch || 'main'
  const sessionTitle = activeSession?.title || 'New Exploration'

  const handleFolderPick = async () => {
    if (onSelectWorkspace) {
      onSelectWorkspace()
      return
    }
    if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI) {
      const folder = await (window as any).ovolveDesktopAPI.selectFolder()
      if (folder) setWorkspaceRoot(folder)
    }
  }

  return (
    <div
      className={cn(
        'inline-flex items-center select-none transition-all duration-200',
        isHero
          ? 'gap-0.5 px-3 py-1 rounded-full bg-card/85 dark:bg-card/45 border border-border/80 dark:border-white/15 shadow-xs backdrop-blur-2xl ring-1 ring-white/30 dark:ring-white/5 mb-3'
          : 'gap-0.5 p-0.5 rounded-full bg-muted/60 dark:bg-card/60 border border-border/80 dark:border-white/15 shadow-2xs backdrop-blur-xl',
        className,
      )}
    >
      {/* 1. Workspace Segment */}
      <button
        type="button"
        onClick={handleFolderPick}
        className="h-6 px-2.5 rounded-full text-xs text-foreground/80 hover:text-foreground hover:bg-background/80 transition-all inline-flex items-center gap-1.5 cursor-pointer"
        title={workspaceRoot || 'Select workspace'}
      >
        <FolderOpen size={12} className="text-primary/90" />
        <span className="truncate max-w-[120px] font-medium">{workspaceName}</span>
      </button>

      {/* Hairline Divider */}
      <div className={cn('w-[1px] bg-border/80 dark:bg-white/10 shrink-0', isHero ? 'h-3.5 mx-1' : 'h-3')} />

      {/* 2. Git Branch Segment */}
      <div
        className="h-6 px-2.5 rounded-full text-xs text-foreground/80 hover:text-foreground hover:bg-background/80 transition-all inline-flex items-center gap-1.5 cursor-default"
        title={`Git branch: ${branchName}`}
      >
        <GitBranch size={12} className="text-emerald-500" />
        <span className="truncate max-w-[100px] font-mono">{branchName}</span>
      </div>

      {/* Hairline Divider */}
      <div className={cn('w-[1px] bg-border/80 dark:bg-white/10 shrink-0', isHero ? 'h-3.5 mx-1' : 'h-3')} />

      {/* 3. Session Trail Segment */}
      <div
        className="h-6 px-2.5 rounded-full text-xs text-foreground/75 inline-flex items-center gap-1.5"
        title={`Current session: ${sessionTitle}`}
      >
        <MessageSquare size={12} className="text-indigo-400" />
        <span className="truncate max-w-[130px]">{sessionTitle}</span>
      </div>
    </div>
  )
}

export default SessionTripartiteCapsule
