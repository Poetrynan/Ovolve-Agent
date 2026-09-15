import React, { useState, useEffect } from 'react'
import {
  Plus,
  MessageSquare,
  Trash2,
  Settings,
  Search,
  FolderPlus,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  GitBranch,
  MoreVertical,
  ExternalLink,
} from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

export const SessionSidebar: React.FC = () => {
  const [search, setSearch] = useState('')
  const [workspaceOpen, setWorkspaceOpen] = useState(true)

  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const createSession = useAgentStore((s) => s.createSession)
  const selectSession = useAgentStore((s) => s.selectSession)
  const deleteSession = useAgentStore((s) => s.deleteSession)
  const toggleSettings = useAgentStore((s) => s.toggleSettings)
  const workspaceRoot = useAgentStore((s) => s.workspaceRoot)
  const setWorkspaceRoot = useAgentStore((s) => s.setWorkspaceRoot)
  const isStreaming = useAgentStore((s) => s.isStreaming)
  const isThinking = useAgentStore((s) => s.isThinking)

  // Listen for global ⌘N / Ctrl+N from electron main
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).electronAPI?.on) {
      const unsub = (window as any).electronAPI.on('app:new-session', () => {
        createSession()
      })
      const unsubSettings = (window as any).electronAPI.on('app:open-settings', () => {
        toggleSettings(true)
      })
      return () => {
        unsub()
        unsubSettings()
      }
    }
  }, [createSession, toggleSettings])

  const filteredSessions = sessions.filter((s) =>
    s.title.toLowerCase().includes(search.toLowerCase()),
  )

  const handleAddWorkspaceFolder = async () => {
    if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.selectFolder) {
      const folder = await (window as any).ovolveDesktopAPI.selectFolder()
      if (folder) setWorkspaceRoot(folder)
    }
  }

  const handleRevealWorkspace = () => {
    if (workspaceRoot && typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.workspace?.revealInExplorer) {
      (window as any).ovolveDesktopAPI.workspace.revealInExplorer(workspaceRoot)
    }
  }

  const workspaceName = workspaceRoot ? workspaceRoot.split(/[\\/]/).pop() || 'Workspace' : null

  return (
    <aside className="w-64 h-full bg-card/65 dark:bg-[#0e1017]/65 backdrop-blur-2xl border-r border-border/70 dark:border-white/10 flex flex-col justify-between select-none overflow-hidden shrink-0">
      {/* Top Action Bar */}
      <div className="p-3 space-y-2.5">
        <button
          type="button"
          onClick={() => createSession()}
          className="w-full h-8.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-xs flex items-center justify-between px-3 shadow-xs transition-all active:scale-[0.98] cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <Plus size={14} />
            <span>New Chat</span>
          </div>
          <span className="text-[10px] opacity-70 font-mono">⌘N</span>
        </button>

        {/* Search */}
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search chats..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-8 pl-8 pr-2 text-xs rounded-lg bg-muted/50 dark:bg-white/[0.04] border border-border/70 dark:border-white/10 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all font-sans"
          />
        </div>
      </div>

      {/* Main Nav & Session Tree */}
      <div className="flex-1 overflow-y-auto px-2 space-y-3">
        {/* Multi-Root Workspace Tree Accordion */}
        <div className="space-y-1">
          <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            <button
              type="button"
              onClick={() => setWorkspaceOpen(!workspaceOpen)}
              className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
            >
              {workspaceOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <span>Workspace</span>
            </button>

            <button
              type="button"
              onClick={handleAddWorkspaceFolder}
              className="hover:text-primary transition-colors cursor-pointer"
              title="Add Workspace Folder"
            >
              <FolderPlus size={12} />
            </button>
          </div>

          {workspaceOpen && (
            <div className="pl-1 space-y-0.5 animate-in fade-in duration-150">
              {workspaceRoot ? (
                <div className="group flex items-center justify-between px-2 py-1.5 rounded-lg text-xs bg-muted/40 dark:bg-white/[0.03] border border-border/50 dark:border-white/5 text-foreground/90">
                  <div className="flex items-center gap-2 truncate min-w-0">
                    <FolderOpen size={13} className="text-primary shrink-0" />
                    <span className="font-medium truncate text-[11px]">{workspaceName}</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleRevealWorkspace}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-primary transition-opacity cursor-pointer"
                    title="Reveal in File Explorer"
                  >
                    <ExternalLink size={11} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleAddWorkspaceFolder}
                  className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground border border-dashed border-border/80 dark:border-white/10 transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <FolderPlus size={12} />
                  <span className="text-[11px]">Open Workspace Folder...</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Sessions List */}
        <div className="space-y-1">
          <div className="px-2 py-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            Recent Conversations
          </div>

          <div className="space-y-0.5">
            {filteredSessions.map((session) => {
              const isActive = session.id === activeSessionId
              const isWorking = isActive && (isStreaming || isThinking)

              return (
                <div
                  key={session.id}
                  onClick={() => selectSession(session.id)}
                  className={`group flex items-center justify-between px-2.5 py-2 rounded-lg text-xs cursor-pointer transition-all ${
                    isActive
                      ? 'bg-primary/15 text-foreground font-medium border border-primary/30 shadow-xs'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate pr-1 min-w-0">
                    {/* Liveness dot */}
                    {isWorking ? (
                      <span className="w-2 h-2 rounded-full bg-primary animate-ping shrink-0" />
                    ) : (
                      <MessageSquare
                        size={13}
                        className={`shrink-0 ${isActive ? 'text-primary' : 'text-muted-foreground/60'}`}
                      />
                    )}
                    <span className="truncate text-[11.5px]">{session.title}</span>
                  </div>

                  {/* Actions popover / delete */}
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                    {sessions.length > 1 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteSession(session.id)
                        }}
                        className="p-1 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                        title="Delete session"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Bottom Settings Link */}
      <div className="p-2.5 border-t border-border/70 dark:border-white/10 space-y-1 bg-muted/20 dark:bg-white/[0.01]">
        <button
          type="button"
          onClick={() => toggleSettings(true)}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <Settings size={13} className="text-muted-foreground" />
            <span className="text-[11.5px]">Settings & Models</span>
          </div>
          <span className="text-[10px] font-mono opacity-50">⌘,</span>
        </button>
      </div>
    </aside>
  )
}

export default SessionSidebar
