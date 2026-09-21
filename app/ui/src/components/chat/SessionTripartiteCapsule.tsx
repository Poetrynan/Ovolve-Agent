// src/components/chat/SessionTripartiteCapsule.tsx
// Tripartite context capsules: [Workspace / Project] | [Git branch] | [Ovolve Session]
// Supports Dual-Posture: 'hero' (Attached tab seamlessly growing out of Composer top) vs 'header' (Chat Header docked state).
import { useEffect, useMemo, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FolderGit2, GitBranch, ChevronDown, Search, Check, Plus, GitGraph, ArrowRight, FolderPlus, Folder, X
} from 'lucide-react'
import { cn } from '@lib/utils'
import { useGitStore } from '@store/gitStore'
import { useSidePanelStore } from '@store/sidePanelStore'
import { useSessionListStore } from '@store/sessionListStore'
import { Tooltip, TooltipContent, TooltipTrigger } from '@components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@components/ui/popover'

interface SessionTripartiteCapsuleProps {
  variant?: 'hero' | 'header'
  className?: string
}

export function SessionTripartiteCapsule({
  variant = 'header',
  className,
}: SessionTripartiteCapsuleProps) {
  const { t } = useTranslation()
  const activeWorkspace = useSessionListStore((s) => s.activeWorkspace)
  const workspaces = useSessionListStore((s) => s.workspaces)
  const switchWorkspace = useSessionListStore((s) => s.switchWorkspace)

  const gitStatus = useGitStore((s) => s.status)
  const branches = useGitStore((s) => s.branches)
  const refreshGit = useGitStore((s) => s.refresh)
  const checkoutBranch = useGitStore((s) => s.checkout)
  const createAndCheckout = useGitStore((s) => s.createAndCheckout)
  const openTab = useSidePanelStore((s) => s.openTab)
  const sessionList = useSessionListStore((s) => s.sessions)

  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState('')
  const [gitOpen, setGitOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [newBranchInput, setNewBranchInput] = useState('')
  const [switching, setSwitching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void refreshGit()
  }, [refreshGit])

  useEffect(() => {
    if (isCreating) {
      inputRef.current?.focus()
    }
  }, [isCreating])

  // Global shortcut Ctrl+; (or Cmd+;) to toggle workspace picker
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ';') {
        e.preventDefault()
        setWorkspaceOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const projectName = activeWorkspace ? (activeWorkspace.split(/[\\/]/).pop() || activeWorkspace) : t('sidebar.defaultWorkspace', '默认工作区')
  const branchName = gitStatus?.branch || 'main'
  const changedCount = gitStatus?.changes?.length || 0

  const isHero = variant === 'hero'

  // Gather unique workspaces
  const allWorkspaces = useMemo(() => {
    const map = new Map<string, { path: string; name: string }>()
    workspaces.forEach((w) => {
      if (w.path) {
        const name = w.display_name || w.path.split(/[\\/]/).pop() || w.path
        map.set(w.path, { path: w.path, name })
      }
    })
    sessionList.forEach((s) => {
      if (s.workspace && !map.has(s.workspace)) {
        const name = s.workspace.split(/[\\/]/).pop() || s.workspace
        map.set(s.workspace, { path: s.workspace, name })
      }
    })
    if (activeWorkspace && !map.has(activeWorkspace)) {
      const name = activeWorkspace.split(/[\\/]/).pop() || activeWorkspace
      map.set(activeWorkspace, { path: activeWorkspace, name })
    }
    return Array.from(map.values())
  }, [workspaces, sessionList, activeWorkspace])

  const filteredWorkspaces = useMemo(() => {
    if (!workspaceSearchQuery.trim()) return allWorkspaces
    const q = workspaceSearchQuery.toLowerCase()
    return allWorkspaces.filter(w => w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q))
  }, [allWorkspaces, workspaceSearchQuery])

  const handleSelectWorkspace = (path: string) => {
    if (path !== activeWorkspace) {
      switchWorkspace(path)
    }
    setWorkspaceOpen(false)
  }

  const handlePickFolder = async () => {
    try {
      const dir = await window.electronAPI?.invoke('file:pickDirectory')
      if (dir) {
        switchWorkspace(dir)
        setWorkspaceOpen(false)
      }
    } catch (err) {
      console.error('Pick directory failed', err)
    }
  }

  const handleClearWorkspace = () => {
    switchWorkspace('')
    setWorkspaceOpen(false)
  }

  // Filtered branches list
  const filteredBranches = useMemo(() => {
    const list = branches.length > 0 ? branches : [branchName]
    if (!searchQuery.trim()) return list
    return list.filter((b) => b.toLowerCase().includes(searchQuery.toLowerCase()))
  }, [branches, branchName, searchQuery])

  const handleCheckout = async (targetBranch: string) => {
    if (targetBranch === branchName || switching) return
    setSwitching(true)
    try {
      await checkoutBranch(targetBranch)
      setGitOpen(false)
    } finally {
      setSwitching(false)
    }
  }

  const handleCreateBranch = async () => {
    const name = newBranchInput.trim()
    if (!name || switching) return
    setSwitching(true)
    try {
      await createAndCheckout(name)
      setIsCreating(false)
      setNewBranchInput('')
      setGitOpen(false)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div
      className={cn(
        'inline-flex items-center select-none transition-all duration-200',
        isHero
          ? 'gap-0.5 px-2.5 py-1 rounded-t-2xl bg-card/85 dark:bg-card/45 border border-border/80 dark:border-white/15 border-b-0 shadow-xs backdrop-blur-2xl ring-1 ring-white/30 dark:ring-white/5'
          : 'gap-0.5 p-0.5 rounded-full bg-muted/60 dark:bg-card/60 border border-border/80 dark:border-white/15 shadow-2xs backdrop-blur-xl',
        className,
      )}
    >
      {/* 1. Workspace / Project Capsule (Interactive Popover) */}
      <Popover
        open={workspaceOpen}
        onOpenChange={(v) => {
          setWorkspaceOpen(v)
          if (v) setWorkspaceSearchQuery('')
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex items-center gap-1.5 font-medium transition-all press-feedback cursor-pointer group',
                  isHero
                    ? 'h-6 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60'
                    : 'h-6 px-2.5 rounded-full text-xs text-foreground/80 hover:text-foreground hover:bg-background/80',
                )}
              >
                <FolderGit2 size={isHero ? 13 : 12} className="text-primary/90 shrink-0" />
                <span className="truncate max-w-[120px]">{projectName}</span>
                <ChevronDown size={isHero ? 11 : 10} className="opacity-50 group-hover:opacity-100 shrink-0" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side={isHero ? 'top' : 'bottom'}>
            <div className="text-xs">
              <div className="font-semibold">{projectName}</div>
              <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                {activeWorkspace || t('chatPage.defaultSandbox', '全局默认沙箱（未关联特定项目目录）')}
              </div>
              <div className="text-[10px] text-primary mt-1">选择项目 (Ctrl+;)</div>
            </div>
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          align={isHero ? 'center' : 'start'}
          side="bottom"
          className="w-[280px] p-2 shadow-xl rounded-xl border border-border/80 bg-popover max-h-[380px] flex flex-col z-50 select-none"
        >
          {/* Search Input */}
          <div className="relative mb-2">
            <Search size={13} className="absolute left-2.5 top-2 text-muted-foreground" />
            <input
              type="text"
              autoFocus
              value={workspaceSearchQuery}
              onChange={(e) => setWorkspaceSearchQuery(e.target.value)}
              placeholder="搜索工作区..."
              className="w-full h-7 pl-7 pr-2 rounded-lg bg-muted/50 text-xs text-foreground placeholder:text-muted-foreground/60 border border-border/40 focus:outline-none focus:border-primary/60"
            />
          </div>

          <div className="px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
            工作区 (Workspaces)
          </div>

          {/* Workspace List */}
          <div className="flex-1 overflow-y-auto space-y-0.5 my-1 max-h-[190px]">
            {filteredWorkspaces.map((w) => {
              const isCurrent = w.path === activeWorkspace
              return (
                <button
                  key={w.path}
                  type="button"
                  onClick={() => handleSelectWorkspace(w.path)}
                  className={cn(
                    'w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left transition-colors cursor-pointer group',
                    isCurrent ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent text-foreground',
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <FolderGit2 size={13} className={cn('shrink-0', isCurrent ? 'text-primary' : 'text-muted-foreground')} />
                    <div className="truncate text-xs">{w.name}</div>
                  </div>
                  {isCurrent && <Check size={12} className="text-primary shrink-0 ml-1" />}
                </button>
              )
            })}
            {filteredWorkspaces.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                暂无匹配的工作区
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="h-px bg-border/40 my-1" />

          {/* Action buttons */}
          <div className="space-y-0.5">
            <button
              type="button"
              onClick={handlePickFolder}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              <FolderPlus size={13} className="text-muted-foreground" />
              <span>打开文件夹</span>
            </button>
            <button
              type="button"
              onClick={handleClearWorkspace}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              <X size={13} />
              <span>不在项目中工作</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Crisp Vertical Hairline Divider */}
      <div className={cn("w-[1px] bg-border/80 shrink-0", isHero ? "h-3.5 mx-1 bg-border/70" : "h-3")} />

      {/* 2. Git Branch Capsule (Interactive Popover) */}
      <Popover
        open={gitOpen}
        onOpenChange={(v) => {
          setGitOpen(v)
          if (v) {
            void refreshGit()
            setIsCreating(false)
            setSearchQuery('')
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1.5 font-medium transition-all press-feedback cursor-pointer',
              isHero
                ? 'h-6 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60'
                : 'h-6 px-2.5 rounded-full text-xs text-foreground/80 hover:text-foreground hover:bg-background/80',
            )}
            title={`Git 分支: ${branchName}`}
          >
            <GitBranch size={isHero ? 13 : 11} className="text-emerald-500 shrink-0" />
            <span className="truncate max-w-[130px]">{branchName}</span>
            {changedCount > 0 && (
              <span
                className="px-1 py-0.1 rounded-full text-[9px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 shrink-0"
                title={`${changedCount} 项未提交变更`}
              >
                +{changedCount}
              </span>
            )}
            <ChevronDown size={isHero ? 11 : 10} className="opacity-50 shrink-0" />
          </button>
        </PopoverTrigger>

        <PopoverContent
          align={isHero ? 'center' : 'start'}
          side="bottom"
          className="w-[280px] p-2 shadow-xl rounded-xl border border-border/80 bg-popover max-h-[380px] flex flex-col"
        >
          {/* Search Input */}
          <div className="relative mb-2">
            <Search size={13} className="absolute left-2.5 top-2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索分支..."
              className="w-full h-7 pl-7 pr-2 rounded-lg bg-muted/50 text-xs text-foreground placeholder:text-muted-foreground/60 border border-border/40 focus:outline-none focus:border-primary/60"
            />
          </div>

          <div className="px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
            分支 (Branches)
          </div>

          {/* Branch List */}
          <div className="flex-1 overflow-y-auto space-y-0.5 my-1 max-h-[190px]">
            {filteredBranches.map((b) => {
              const isCurrent = b === branchName
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => handleCheckout(b)}
                  disabled={switching}
                  className={cn(
                    'w-full flex items-start gap-2 px-2 py-1.5 rounded-lg text-left transition-colors cursor-pointer group',
                    isCurrent ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent text-foreground',
                  )}
                >
                  <GitBranch size={13} className={cn('shrink-0 mt-0.5', isCurrent ? 'text-primary' : 'text-muted-foreground')} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs truncate">{b}</span>
                      {isCurrent && <Check size={12} className="text-primary shrink-0 ml-1" />}
                    </div>
                    {isCurrent && (
                      <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                        {changedCount > 0 ? `未提交的更改: ${changedCount} 个文件` : '暂无改动'}
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
            {filteredBranches.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                未找到匹配的分支
              </div>
            )}
          </div>

          {/* Bottom Actions Divider */}
          <div className="h-px bg-border/40 my-1" />

          {/* Create Branch or Inline Input */}
          {isCreating ? (
            <div className="p-1 space-y-1.5 animate-in fade-in duration-150">
              <input
                ref={inputRef}
                type="text"
                value={newBranchInput}
                onChange={(e) => setNewBranchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateBranch()
                  if (e.key === 'Escape') setIsCreating(false)
                }}
                placeholder="新分支名称 (回车创建)..."
                className="w-full h-7 px-2 rounded-md bg-muted/60 text-xs text-foreground placeholder:text-muted-foreground/60 border border-primary/50 focus:outline-none"
              />
              <div className="flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => setIsCreating(false)}
                  className="px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleCreateBranch}
                  disabled={!newBranchInput.trim() || switching}
                  className="px-2 py-0.5 rounded text-[11px] font-medium bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50"
                >
                  创建并检出
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsCreating(true)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-foreground hover:bg-accent/80 transition-colors cursor-pointer"
            >
              <Plus size={13} className="text-primary shrink-0" />
              <span>创建并检出新分支...</span>
            </button>
          )}

          {/* Open Git Panel */}
          <button
            type="button"
            onClick={() => {
              setGitOpen(false)
              openTab('git')
            }}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <GitGraph size={13} className="shrink-0" />
              <span>Git 审阅面板与图谱</span>
            </div>
            <ArrowRight size={11} className="opacity-60" />
          </button>
        </PopoverContent>
      </Popover>
    </div>
  )
}
