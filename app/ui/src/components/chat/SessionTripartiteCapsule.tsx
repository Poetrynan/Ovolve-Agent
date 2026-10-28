// src/components/chat/SessionTripartiteCapsule.tsx
// Scope controls: which project this conversation belongs to, and which branch
// it edits. Three postures share one component:
//   • 'composer' — the branch chip alone, in the input row beside the model
//     picker, which is where the eye already is when the prompt is written.
//   • 'hero'     — the project tray under an empty-state composer.
//   • 'header'   — the docked pill in the chat header.
import { useEffect, useMemo, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FolderGit2, GitBranch, ChevronDown, ChevronRight, Search, Check, Plus, GitGraph,
  ArrowRight, FolderPlus, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@lib/utils'
import { useGitStore } from '@store/gitStore'
import { useSidePanelStore } from '@store/sidePanelStore'
import { useSessionListStore } from '@store/sessionListStore'
import { Tooltip, TooltipContent, TooltipTrigger } from '@components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@components/ui/popover'

interface SessionTripartiteCapsuleProps {
  variant?: 'hero' | 'header' | 'composer'
  className?: string
  /**
   * The input row owns the branch chip, so the tray below it and the header
   * capsule drop theirs — the same branch must not sit on screen twice.
   */
  hideBranch?: boolean
}

export function SessionTripartiteCapsule({
  variant = 'header',
  className,
  hideBranch = false,
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

  const isHero = variant === 'hero'
  const isComposer = variant === 'composer'

  useEffect(() => {
    if (activeWorkspace) {
      void refreshGit()
    }
  }, [activeWorkspace, refreshGit])

  useEffect(() => {
    if (isCreating) {
      inputRef.current?.focus()
    }
  }, [isCreating])

  // Global shortcut Ctrl+; (or Cmd+;) to toggle the project picker
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ';') {
        e.preventDefault()
        setWorkspaceOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const hasProject = Boolean(activeWorkspace)
  const projectName = hasProject
    ? (workspaces.find((w) => w.path === activeWorkspace)?.display_name ||
       activeWorkspace.split(/[\\/]/).pop() ||
       activeWorkspace)
    : '进入项目工作'
  const branchName = gitStatus?.branch || ''
  const changedCount = gitStatus?.changes?.length || 0
  const showGitBranch = hasProject && Boolean(gitStatus?.isGitRepository && branchName)

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
    return allWorkspaces.filter((w) => w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q))
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
    if (activeWorkspace !== '') {
      switchWorkspace('')
    }
    setWorkspaceOpen(false)
  }

  const filteredBranches = useMemo(() => {
    const list = branches.length > 0 ? branches : branchName ? [branchName] : []
    if (!searchQuery.trim()) return list
    return list.filter((b) => b.toLowerCase().includes(searchQuery.toLowerCase()))
  }, [branches, branchName, searchQuery])

  const handleCheckout = async (targetBranch: string) => {
    if (targetBranch === branchName || switching) return
    setSwitching(true)
    try {
      await checkoutBranch(targetBranch)
      setGitOpen(false)
    } catch (e: any) {
      // A refusal is the interesting outcome — it arrives with the files that
      // would be overwritten, and silence here reads as "the click did nothing".
      toast.error(e?.message || '切换分支失败')
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
    } catch (e: any) {
      toast.error(e?.message || '创建分支失败')
    } finally {
      setSwitching(false)
    }
  }

  const projectChipClass = isHero
    ? 'h-7 px-2.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/5'
    : 'h-6 px-2.5 rounded-full text-xs text-foreground/80 hover:text-foreground hover:bg-background/80'
  const branchChipClass = isHero
    ? projectChipClass
    : isComposer
      ? 'h-7 px-2.5 rounded-xl text-xs text-foreground/80 hover:text-foreground hover:bg-foreground/5 min-w-0 shrink'
      : 'h-6 px-2.5 rounded-full text-xs text-foreground/80 hover:text-foreground hover:bg-background/80'

  return (
    <div
      className={cn(
        'inline-flex items-center select-none transition-all duration-200',
        isHero
          ? 'gap-1'
          : isComposer
            ? 'gap-1 min-w-0'
            : 'gap-0.5 p-0.5 rounded-full bg-muted/60 dark:bg-card/60 border border-border/80 dark:border-white/15 shadow-2xs backdrop-blur-xl',
        className,
      )}
    >
      {/* 1. Project Picker */}
      {!isComposer && (
        <Popover
          open={workspaceOpen}
          onOpenChange={(v) => {
            setWorkspaceOpen(v)
            if (!v) setWorkspaceSearchQuery('')
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center gap-1.5 font-medium transition-colors press-feedback cursor-pointer group',
                    projectChipClass,
                  )}
                >
                  {hasProject && (
                    <FolderGit2 size={isHero ? 14 : 12} className="text-muted-foreground group-hover:text-foreground shrink-0" />
                  )}
                  <span className="truncate max-w-[160px]">{projectName}</span>
                  <ChevronDown size={isHero ? 12 : 10} className="opacity-55 group-hover:opacity-100 shrink-0" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side={isHero ? 'top' : 'bottom'}>
              <div className="text-xs">
                <div className="font-semibold">{hasProject ? projectName : '不使用项目'}</div>
                <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                  {activeWorkspace || t('chatPage.defaultSandbox', '当前未关联特定项目目录（对话归入「最近」）')}
                </div>
                <div className="text-[10px] text-muted-foreground mt-1">切换项目 (Ctrl+;)</div>
              </div>
            </TooltipContent>
          </Tooltip>

          <PopoverContent
            align="start"
            side={isHero ? 'top' : 'bottom'}
            sideOffset={6}
            className="w-[264px] p-1.5 shadow-xl rounded-2xl border border-border/80 bg-popover flex flex-col z-50 select-none"
          >
            <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border/50 mb-1">
              <Search size={13} className="text-muted-foreground/70 shrink-0" />
              <input
                type="text"
                autoFocus
                value={workspaceSearchQuery}
                onChange={(e) => setWorkspaceSearchQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="搜索项目"
                className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/55 focus:outline-none"
              />
            </div>

            <div className="max-h-[160px] overflow-y-auto space-y-0.5 py-0.5">
              {filteredWorkspaces.map((w) => {
                const isCurrent = w.path === activeWorkspace
                return (
                  <button
                    key={w.path}
                    type="button"
                    onClick={() => handleSelectWorkspace(w.path)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left text-[13px] transition-colors cursor-pointer',
                      isCurrent
                        ? 'bg-accent/80 text-foreground font-medium'
                        : 'hover:bg-accent/60 text-foreground/90',
                    )}
                  >
                    <FolderGit2 size={15} className="shrink-0 text-muted-foreground" />
                    <span className="truncate flex-1">{w.name}</span>
                    {isCurrent && <Check size={14} className="text-foreground shrink-0 ml-auto" />}
                  </button>
                )
              })}
              {allWorkspaces.length > 0 && filteredWorkspaces.length === 0 && (
                <div className="px-2.5 py-2 text-xs text-muted-foreground/70">无匹配的项目</div>
              )}
              {allWorkspaces.length === 0 && (
                <div className="px-2.5 py-2 text-xs text-muted-foreground/70">暂无项目</div>
              )}
            </div>

            <div className="h-px bg-border/50 my-1 mx-1" />

            <div className="space-y-0.5">
              <button
                type="button"
                onClick={handlePickFolder}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-[13px] text-foreground/90 hover:bg-accent/60 transition-colors cursor-pointer"
              >
                <FolderPlus size={15} className="text-muted-foreground shrink-0" />
                <span className="flex-1 text-left">添加新项目</span>
                <ChevronRight size={13} className="text-muted-foreground/60 shrink-0" />
              </button>
              <button
                type="button"
                onClick={handleClearWorkspace}
                className={cn(
                  'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-[13px] transition-colors cursor-pointer',
                  !hasProject
                    ? 'text-foreground font-medium bg-accent/50'
                    : 'text-foreground/90 hover:bg-accent/60',
                )}
              >
                <X size={15} className="text-muted-foreground shrink-0" />
                <span className="flex-1 text-left">不使用项目</span>
                {!hasProject && <Check size={14} className="text-foreground shrink-0 ml-auto" />}
              </button>
            </div>
          </PopoverContent>
        </Popover>
      )}

      {/* 2. Git Branch */}
      {showGitBranch && !hideBranch && (
        <>
          {!isHero && !isComposer && <div className="w-[1px] h-3 bg-border/80 shrink-0" />}
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
                  'inline-flex items-center gap-1.5 font-medium transition-colors press-feedback cursor-pointer group',
                  branchChipClass,
                )}
                title={`当前分支：${branchName}`}
              >
                <GitBranch size={isHero || isComposer ? 13 : 11} className="text-muted-foreground group-hover:text-foreground shrink-0" />
                <span className={cn('truncate', isComposer ? 'max-w-[110px] min-w-0' : 'max-w-[130px]')}>{branchName}</span>
                {changedCount > 0 && (
                  <span
                    className="px-1 py-0.1 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 shrink-0"
                    title={`${changedCount} 项未提交变更`}
                  >
                    +{changedCount}
                  </span>
                )}
                <ChevronDown size={isHero ? 12 : isComposer ? 11 : 10} className="opacity-55 group-hover:opacity-100 shrink-0" />
              </button>
            </PopoverTrigger>

            <PopoverContent
              align="start"
              side={isHero || isComposer ? 'top' : 'bottom'}
              sideOffset={6}
              className="w-[264px] p-1.5 shadow-xl rounded-2xl border border-border/80 bg-popover max-h-[380px] flex flex-col z-50"
            >
              <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border/50 mb-1">
                <Search size={13} className="text-muted-foreground/70 shrink-0" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder="搜索分支…"
                  className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/55 focus:outline-none"
                />
              </div>

              <div className="flex-1 overflow-y-auto space-y-0.5 py-0.5 max-h-[190px]">
                <div className="px-2.5 pt-0.5 pb-1 text-[10px] text-muted-foreground/70">本地分支</div>
                {filteredBranches.map((b) => {
                  const isCurrent = b === branchName
                  return (
                    <button
                      key={b}
                      type="button"
                      onClick={() => handleCheckout(b)}
                      disabled={switching}
                      className={cn(
                        'w-full flex items-start gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-colors cursor-pointer',
                        isCurrent
                          ? 'bg-accent/80 text-foreground font-medium'
                          : 'hover:bg-accent/60 text-foreground/90',
                      )}
                    >
                      <GitBranch size={14} className="shrink-0 mt-0.5 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-[13px] truncate">{b}</span>
                          {isCurrent && <Check size={14} className="text-foreground shrink-0 ml-1" />}
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
                {filteredBranches.length === 0 && branches.length > 0 && (
                  <div className="px-2.5 py-2 text-xs text-muted-foreground/70">无匹配的分支</div>
                )}
                {/* A repo always has at least its current branch, so an empty
                    list means the fetch failed, not that there is nothing to
                    switch to. Say so instead of showing a one-row menu. */}
                {branches.length === 0 && (
                  <button
                    type="button"
                    onClick={() => void refreshGit()}
                    className="w-full px-2.5 py-1.5 text-left text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer"
                  >
                    读不到分支列表 · 点这里重试
                  </button>
                )}
              </div>

              <div className="h-px bg-border/50 my-1 mx-1" />

              {isCreating ? (
                <div className="p-1 space-y-1.5 animate-in fade-in duration-150">
                  <input
                    ref={inputRef}
                    type="text"
                    value={newBranchInput}
                    onChange={(e) => setNewBranchInput(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') void handleCreateBranch()
                      if (e.key === 'Escape') setIsCreating(false)
                    }}
                    placeholder="新分支名，回车创建"
                    className="w-full h-7 px-2 rounded-lg bg-muted/60 text-xs text-foreground placeholder:text-muted-foreground/60 border border-border/60 focus:outline-none focus:border-border"
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
                      onClick={() => void handleCreateBranch()}
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
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-[13px] text-foreground/90 hover:bg-accent/60 transition-colors cursor-pointer"
                >
                  <Plus size={15} className="text-muted-foreground shrink-0" />
                  <span>新建分支…</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setGitOpen(false)
                  openTab('git')
                }}
                className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl text-[13px] text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  <GitGraph size={14} className="shrink-0" />
                  <span>Git 审阅面板与图谱</span>
                </div>
                <ArrowRight size={12} className="opacity-60" />
              </button>
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  )
}
