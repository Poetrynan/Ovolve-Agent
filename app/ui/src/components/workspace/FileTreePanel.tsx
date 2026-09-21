import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  RefreshCw,
  FolderOpen,
  FolderTree,
  Search,
  Plus,
  ArrowLeft,
  ArrowRight,
  FileText,
  X,
} from 'lucide-react'
import { useSessionListStore } from '@store/sessionListStore'
import { openReadOnlyFileViewer } from '@store/sidePanelStore'
import { useAgentStore } from '@store/agentStore'
import { OfficialFileIcon } from '@components/ui/OfficialFileIcon'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { cn } from '@lib/utils'

interface Entry {
  name: string
  path: string
  isDir: boolean
  size?: number
  mtime?: number
}

export interface RecentItem {
  path: string
  name: string
  relPath: string
  status?: 'M' | 'A' | 'D' | 'read'
  timestamp?: number
}

interface NodeProps {
  entry: Entry
  depth: number
  /** 父层每次 refresh 会 bump；已展开的目录据此静默重取子项。 */
  refreshKey?: number
  onOpenFile?: (path: string, name: string) => void
}

function TreeNode({ entry, depth, refreshKey = 0, onOpenFile }: NodeProps) {
 const [expanded, setExpanded] = useState(false)
 const [children, setChildren] = useState<Entry[] | null>(null)
 const [loading, setLoading] = useState(false)
 const [loadError, setLoadError] = useState(false)

 const loadChildren = useCallback(async () => {
 setLoading(true)
 setLoadError(false)
 try {
 const rows = await window.electronAPI?.invoke('file:listDir', entry.path)
 setChildren(rows ?? [])
 } catch (e) {
 console.warn('[fileTree] listDir failed', e)
 setChildren([])
 setLoadError(true)
 } finally {
 setLoading(false)
 }
 }, [entry.path])

 const toggle = async () => {
 if (!entry.isDir) {
 if (onOpenFile) {
 onOpenFile(entry.path, entry.name)
 } else {
 await openReadOnlyFileViewer(entry.path, entry.name, 1, 'Opened')
 }
 return
 }
 const next = !expanded
 setExpanded(next)
 if (next && children === null) {
 void loadChildren()
 }
 }

 // 刷新只重取根层的话，Agent 新建的文件在已展开的子目录里永远看不见。
 // refreshKey 变化时让已展开的目录静默重取一次。
 useEffect(() => {
 if (refreshKey > 0 && expanded && children !== null) {
 void loadChildren()
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [refreshKey])

 return (
 <div>
 <button
 data-testid="workspace-file-tree-row"
 onClick={toggle}
 style={{ paddingLeft: depth * 14 + 10 }}
 className="w-full flex items-center gap-1.5 pr-2.5 py-1 rounded-lg text-left text-xs hover:bg-accent/60 transition-colors duration-150 ease-out select-none group active:transform-none"
 >
 {entry.isDir ? (
 expanded ? (
 <ChevronDown size={12} className="shrink-0 text-muted-foreground/60" />
 ) : (
 <ChevronRight size={12} className="shrink-0 text-muted-foreground/60" />
 )
 ) : (
 <span className="w-3 shrink-0" />
 )}
 {entry.isDir ? (
 expanded ? (
 <FolderOpen size={13} className="shrink-0 text-foreground/70" />
 ) : (
 <Folder size={13} className="shrink-0 text-muted-foreground" />
 )
 ) : (
 <OfficialFileIcon filename={entry.name} size={13} className="shrink-0" />
 )}
 <span className="truncate text-foreground/85 group-hover:text-foreground font-mono text-[11.5px]">
 {entry.name}
 </span>
 </button>

 {expanded && (
 <div>
 {loading && (
 <div style={{ paddingLeft: (depth + 1) * 14 + 10 }} className="py-1 text-[11px] text-muted-foreground/70 font-mono">
 加载中…
 </div>
 )}
 {children?.map((c) => (
 <TreeNode key={c.path} entry={c} depth={depth + 1} refreshKey={refreshKey} onOpenFile={onOpenFile} />
 ))}
 {children?.length === 0 && !loading && !loadError && (
 <div style={{ paddingLeft: (depth + 1) * 14 + 10 }} className="py-1 text-[11px] text-muted-foreground/60 font-mono">
 (空目录)
 </div>
 )}
 {loadError && !loading && (
 <div style={{ paddingLeft: (depth + 1) * 14 + 10 }} className="py-1 flex items-center gap-2 text-[11px] text-destructive/90 font-mono">
 读取失败
 <button
 onClick={(e) => { e.stopPropagation(); void loadChildren() }}
 className="underline hover:text-destructive"
 >
 重试
 </button>
 </div>
 )}
 </div>
 )}
 </div>
)
}

interface Props {
  onOpenFile?: (path: string) => void
  onCollapse?: () => void
}

function normalizePath(p: string): string {
  let clean = (p || '').trim()
  if (clean.startsWith('file://')) clean = clean.replace(/^file:\/\//, '')
  try { clean = decodeURIComponent(clean) } catch {}
  clean = clean.replace(/^\/([a-zA-Z]:)/, '$1')
  return clean.replace(/\\/g, '/')
}

export function FileTreePanel({ onOpenFile, onCollapse }: Props) {
  const activeWorkspace = useSessionListStore((s) => s.activeWorkspace)
  const toolCalls = useAgentStore((s) => s.toolCalls)
  const [override, setOverride] = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)
  const [rootError, setRootError] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [isBrowseMode, setIsBrowseMode] = useState(false)
  const [creatingFile, setCreatingFile] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<RecentItem[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [gitModified, setGitModified] = useState<Map<string, 'M' | 'A' | 'D'>>(new Map())

  const root = override ?? (activeWorkspace || null)

  // Auto-grant workspace permission on mount or change
  useEffect(() => {
    if (root && window.electronAPI?.invoke) {
      window.electronAPI.invoke('workspace:grant', root).catch(() => {})
    }
  }, [root])

  // Fetch Git status for the workspace
  const fetchGitStatus = useCallback(async (dir: string) => {
    if (!window.electronAPI?.invoke) return
    try {
      const res = await window.electronAPI.invoke('git:status', dir)
      if (res && Array.isArray(res.files)) {
        const map = new Map<string, 'M' | 'A' | 'D'>()
        for (const f of res.files) {
          const st = f.status === 'added' || f.status === 'untracked' ? 'A'
            : f.status === 'deleted' ? 'D' : 'M'
          map.set(normalizePath(f.path), st)
        }
        setGitModified(map)
      }
    } catch {
      // Git status optional, ignore
    }
  }, [])

  const refresh = useCallback(async (dir: string) => {
    setLoading(true)
    setRootError(false)
    try {
      if (window.electronAPI?.invoke) {
        await window.electronAPI.invoke('workspace:grant', dir).catch(() => {})
      }
      const rows = await window.electronAPI?.invoke('file:listDir', dir)
      setEntries(rows ?? [])
      // bump 让已展开的子目录 TreeNode 静默重取，否则刷新只惠及根层
      setRefreshKey((k) => k + 1)
      void fetchGitStatus(dir)
    } catch (e: any) {
      console.warn('[FileTreePanel] listDir fallback', e)
      setEntries([])
      // 失败渲染成"空目录"会误导用户以为工作区没东西，要有显式错误态
      setRootError(true)
    } finally {
      setLoading(false)
    }
  }, [fetchGitStatus])

  useEffect(() => { setOverride(null) }, [activeWorkspace])

  useEffect(() => {
    if (!root) {
      setEntries([])
      return
    }
    void refresh(root)
  }, [root, refresh])

  // Harvest Recents from current session tool calls + Git status + workspace files
  const recents = useMemo<RecentItem[]>(() => {
    const list: RecentItem[] = []
    const seen = new Set<string>()
    const normRoot = root ? normalizePath(root) : ''

    // 1. From tool calls in this session
    if (Array.isArray(toolCalls)) {
      for (let i = toolCalls.length - 1; i >= 0; i--) {
        const tc = toolCalls[i]
        const tool = tc.toolName || ''
        const args = tc.args || {}
        const rawPath = args.TargetFile || args.path || args.filePath || args.target_file || args.AbsolutePath
        if (typeof rawPath === 'string' && rawPath.trim()) {
          const norm = normalizePath(rawPath)
          if (!seen.has(norm)) {
            seen.add(norm)
            const parts = norm.split('/')
            const name = parts.pop() || norm
            let relPath = ''
            if (normRoot && norm.startsWith(normRoot)) {
              relPath = norm.slice(normRoot.length).replace(/^\/+/, '')
              const relParts = relPath.split('/')
              relParts.pop()
              relPath = relParts.join('/')
            } else if (parts.length > 0) {
              relPath = parts.slice(Math.max(0, parts.length - 3)).join('/')
            }

            let status: 'M' | 'A' | 'D' | 'read' = 'read'
            if (tool.includes('write') || tool.includes('create')) status = 'A'
            else if (tool.includes('replace') || tool.includes('edit') || tool.includes('diff')) status = 'M'
            else if (tool.includes('delete') || tool.includes('remove')) status = 'D'

            list.push({
              path: rawPath,
              name,
              relPath,
              status: gitModified.get(norm) || status,
              timestamp: tc.timestamp,
            })
          }
        }
      }
    }

    // 2. From git status modified/untracked files
    gitModified.forEach((status, normPath) => {
      if (!seen.has(normPath)) {
        seen.add(normPath)
        const parts = normPath.split('/')
        const name = parts.pop() || normPath
        let relPath = ''
        if (normRoot && normPath.startsWith(normRoot)) {
          relPath = normPath.slice(normRoot.length).replace(/^\/+/, '')
          const relParts = relPath.split('/')
          relParts.pop()
          relPath = relParts.join('/')
        } else if (parts.length > 0) {
          relPath = parts.slice(Math.max(0, parts.length - 3)).join('/')
        }
        list.push({
          path: normPath,
          name,
          relPath,
          status,
        })
      }
    })

    // 3. Fallback: if list is short, include workspace files from entries
    if (list.length < 5 && entries.length > 0) {
      for (const e of entries) {
        if (!e.isDir) {
          const norm = normalizePath(e.path)
          if (!seen.has(norm)) {
            seen.add(norm)
            list.push({
              path: e.path,
              name: e.name,
              relPath: '',
              status: gitModified.get(norm),
              timestamp: e.mtime,
            })
          }
        }
      }
    }

    return list
  }, [toolCalls, gitModified, entries, root])

  // Filter recents by search query
  const filteredRecents = useMemo(() => {
    if (!searchQuery.trim()) return recents
    const q = searchQuery.toLowerCase()
    return recents.filter(
      (item) => item.name.toLowerCase().includes(q) || item.relPath.toLowerCase().includes(q)
    )
  }, [recents, searchQuery])

  // Filter tree entries by search query.
  // 搜索框写着"搜索文件、目录"，但 entries 只有根层——深层文件永远搜不到。
  // 有查询词时对整个工作区做一次广度优先遍历（跳过依赖目录，限量防卡），
  // 返回扁平结果列表；清空查询词恢复原树。
  useEffect(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q || !root || !window.electronAPI?.invoke) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const run = async () => {
      const results: RecentItem[] = []
      const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.venv', '__pycache__', '.next', 'target'])
      const queue: Array<{ dir: string; rel: string }> = [{ dir: root, rel: '' }]
      let visited = 0
      while (queue.length > 0 && results.length < 50 && visited < 800) {
        if (cancelled) return
        const { dir, rel } = queue.shift()!
        visited++
        let rows: Entry[] = []
        try {
          rows = (await window.electronAPI!.invoke('file:listDir', dir)) ?? []
        } catch {
          continue
        }
        for (const e of rows) {
          if (cancelled) return
          const childRel = rel ? `${rel}/${e.name}` : e.name
          if (e.name.toLowerCase().includes(q)) {
            results.push({
              path: e.path,
              name: e.name,
              relPath: childRel.split('/').slice(0, -1).join('/'),
              status: gitModified.get(normalizePath(e.path)),
            })
            if (results.length >= 50) break
          }
          if (e.isDir && !SKIP.has(e.name.toLowerCase())) {
            queue.push({ dir: e.path, rel: childRel })
          }
        }
      }
      if (!cancelled) {
        setSearchResults(results)
        setSearching(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [searchQuery, root, gitModified])

  const handleOpenFile = async (filePath: string, name?: string, status?: string) => {
    const fn = name || filePath.split(/[\\/]/).pop() || filePath
    setHistory((prev) => {
      const next = [...prev.slice(0, historyIdx + 1), filePath]
      setHistoryIdx(next.length - 1)
      return next
    })

    if (onOpenFile) {
      onOpenFile(filePath)
    } else {
      await openReadOnlyFileViewer(filePath, fn, 1, status === 'M' ? 'Modified' : 'Opened')
    }
  }

  const handleHistoryBack = () => {
    if (historyIdx > 0) {
      const target = history[historyIdx - 1]
      setHistoryIdx(historyIdx - 1)
      const fn = target.split(/[\\/]/).pop() || target
      if (onOpenFile) onOpenFile(target)
      else void openReadOnlyFileViewer(target, fn, 1, 'Opened')
    }
  }

  const handleHistoryForward = () => {
    if (historyIdx < history.length - 1) {
      const target = history[historyIdx + 1]
      setHistoryIdx(historyIdx + 1)
      const fn = target.split(/[\\/]/).pop() || target
      if (onOpenFile) onOpenFile(target)
      else void openReadOnlyFileViewer(target, fn, 1, 'Opened')
    }
  }

  const handleCreateNewFile = async () => {
    const trimmed = newFilePath.trim()
    if (!trimmed || !root) return
    const isAbs = /^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('/')
    const full = isAbs ? trimmed : `${root.replace(/[\\/]+$/, '')}/${trimmed.replace(/^[\\/]+$/, '')}`
    try {
      await window.electronAPI?.invoke('file:writeText', full, '')
      setNewFilePath('')
      setCreateError(null)
      setCreatingFile(false)
      await refresh(root)
      await handleOpenFile(full, trimmed.split(/[\\/]/).pop() || trimmed, 'A')
    } catch (e: any) {
      console.warn('Create file failed:', e)
      // 静默失败会让用户以为创建成功了。多级路径父目录不存在是常见原因。
      setCreateError(e?.message || '创建失败：路径不存在或无写入权限')
    }
  }

  const openInExplorer = () => {
    if (root && window.electronAPI?.invoke) {
      window.electronAPI.invoke('workspace:revealInExplorer', root).catch(() => {})
    }
  }

  return (
    <div data-testid="workspace-file-tree-panel" className="flex flex-col h-full select-none bg-card/30">
      {/* 1. Header Toolbar matching Image 2 */}
      <div className="flex items-center justify-between gap-1.5 px-3 py-2 border-b border-border/40 bg-muted/10 shrink-0">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-[13px] font-semibold text-foreground/90 font-mono flex items-center gap-1.5">
            <FolderTree size={14} className="text-sky-500" />
            <span>Files</span>
          </span>
          <div className="flex items-center ml-2 border border-border/40 rounded-lg p-0.5 bg-background/50">
            <button
              onClick={handleHistoryBack}
              disabled={historyIdx <= 0}
              className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
              title="后退"
            >
              <ArrowLeft size={11} />
            </button>
            <button
              onClick={handleHistoryForward}
              disabled={historyIdx >= history.length - 1}
              className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
              title="前进"
            >
              <ArrowRight size={11} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={openInExplorer}
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            title="打开所在文件夹"
          >
            <FolderOpen size={12} />
          </button>
          <button
            data-testid="workspace-file-tree-refresh-button"
            onClick={() => root && refresh(root)}
            disabled={!root || loading}
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40"
            title="刷新工作区"
          >
            <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors ml-0.5"
              title="收起侧边栏"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* 2. Fast Search Bar */}
      <div className="px-2.5 pt-2.5 pb-1 shrink-0">
        <div className="relative flex items-center">
          <Search size={13} className="absolute left-2.5 text-muted-foreground/60 pointer-events-none" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索文件、目录..."
            className="h-8 pl-8 pr-2.5 text-xs bg-background/70 border-border/50 rounded-xl placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-primary/40"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 text-muted-foreground/60 hover:text-foreground p-0.5"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* 3. Quick Action Buttons: Browse Files & New File */}
      <div className="px-2.5 py-1.5 flex items-center gap-1.5 shrink-0 border-b border-border/20">
        <button
          onClick={() => setIsBrowseMode(!isBrowseMode)}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 h-7 px-2 rounded-lg text-xs font-medium transition-all duration-150 border',
            isBrowseMode
              ? 'bg-accent/80 text-foreground border-border/70 shadow-2xs font-semibold'
              : 'bg-muted/20 text-muted-foreground hover:text-foreground hover:bg-muted/40 border-border/30'
          )}
        >
          <FileText size={12} />
          <span>Browse Files</span>
        </button>

        <button
          onClick={() => setCreatingFile(!creatingFile)}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 h-7 px-2 rounded-lg text-xs font-medium transition-all duration-150 border',
            creatingFile
              ? 'bg-accent/80 text-foreground border-border/70 shadow-2xs font-semibold'
              : 'bg-muted/20 text-muted-foreground hover:text-foreground hover:bg-muted/40 border-border/30'
          )}
        >
          <Plus size={12} />
          <span>New File</span>
        </button>
      </div>

      {/* Inline New File Creator */}
      {creatingFile && (
        <div className="px-2.5 py-2 bg-muted/30 border-b border-border/30 shrink-0">
          <div className="text-[11px] text-muted-foreground mb-1 font-mono">新建文件路径：</div>
          <div className="flex items-center gap-1.5">
            <Input
              autoFocus
              value={newFilePath}
              onChange={(e) => setNewFilePath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateNewFile()
                if (e.key === 'Escape') setCreatingFile(false)
              }}
              placeholder="e.g. src/utils.ts"
              className="h-7 text-xs bg-background rounded-lg font-mono"
            />
            <Button size="sm" onClick={handleCreateNewFile} className="h-7 px-2.5 text-xs rounded-lg">
              创建
            </Button>
          </div>
          {createError && (
            <div className="mt-1.5 text-[11px] text-destructive">{createError}</div>
          )}
        </div>
      )}

      {/* 4. Content Area: Recents View (Default) vs Browse Tree */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1">
        {!root && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8">
            <div className="w-10 h-10 rounded-xl bg-muted/40 flex items-center justify-center mx-auto text-muted-foreground/60 border border-border/40 mb-3">
              <FolderTree size={20} />
            </div>
            <div className="text-xs font-semibold text-foreground/80 mb-1">工作区未开启</div>
            <p className="text-[11px] text-muted-foreground/60 max-w-[200px] leading-relaxed">
              在左侧打开或切换项目会话，即可在此管理 Agent 变动资产。
            </p>
          </div>
        )}

        {rootError && root && (
          <div className="mx-1 my-1 p-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-[11px] flex items-center justify-between gap-2">
            <span className="truncate">工作区目录读取失败</span>
            <button
              onClick={() => root && refresh(root)}
              className="shrink-0 underline hover:text-destructive"
            >
              重试
            </button>
          </div>
        )}

        {/* View Mode 1: Full Browse Files Tree */}
        {isBrowseMode && root && (
          <div className="py-1">
            <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground font-mono uppercase tracking-wider">
              {searchResults ? 'Search Results' : 'Workspace Tree'}
            </div>
            {searchQuery.trim() ? (
              searching ? (
                <div className="p-4 text-center text-xs text-muted-foreground font-mono">搜索中…</div>
              ) : (
                <>
                  <div className="space-y-0.5">
                    {searchResults?.map((item) => (
                      <button
                        key={item.path}
                        onClick={() => handleOpenFile(item.path, item.name, item.status)}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl text-left hover:bg-accent/60 transition-colors group cursor-pointer"
                      >
                        <OfficialFileIcon filename={item.name} size={14} className="shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] font-medium text-foreground/90 group-hover:text-foreground font-mono truncate">
                            {item.name}
                          </div>
                          {item.relPath && (
                            <div className="text-[10px] text-muted-foreground/60 font-mono truncate">
                              {item.relPath}
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                  {searchResults?.length === 0 && (
                    <div className="p-4 text-center text-xs text-muted-foreground font-mono">
                      未找到匹配项
                    </div>
                  )}
                  {(searchResults?.length ?? 0) >= 50 && (
                    <div className="p-2 text-center text-[10px] text-muted-foreground/70 font-mono">
                      结果过多，仅显示前 50 条
                    </div>
                  )}
                </>
              )
            ) : (
              <>
                {entries.map((e) => (
                  <TreeNode key={e.path} entry={e} depth={0} refreshKey={refreshKey} onOpenFile={(p, name) => handleOpenFile(p, name)} />
                ))}
                {entries.length === 0 && !loading && !rootError && (
                  <div className="p-4 text-center text-xs text-muted-foreground font-mono">
                    (空目录)
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* View Mode 2: Recents-First Paradigm matching Image 2 */}
        {!isBrowseMode && root && (
          <div className="py-1">
            <div className="px-2.5 py-1 text-[11px] font-semibold text-muted-foreground/80 font-mono tracking-wider">
              Recents
            </div>

            {filteredRecents.length === 0 && !loading && (
              <div className="py-8 text-center text-xs text-muted-foreground/70 font-mono space-y-2">
                <div className="text-[11.5px]">当前会话暂无变动文件</div>
                <button
                  onClick={() => setIsBrowseMode(true)}
                  className="text-primary hover:underline text-[11px]"
                >
                  点击浏览全部工作区文件 →
                </button>
              </div>
            )}

            <div className="space-y-0.5">
              {filteredRecents.map((item) => (
                <button
                  key={item.path}
                  onClick={() => handleOpenFile(item.path, item.name, item.status)}
                  className="w-full flex items-start gap-2.5 px-2.5 py-1.5 rounded-xl text-left hover:bg-accent/60 transition-colors group cursor-pointer"
                >
                  {/* Left Icon & Micro-chroma status badge */}
                  <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                    {item.status && item.status !== 'read' && (
                      <span
                        className={cn(
                          'text-[10.5px] font-mono font-bold px-1 py-0.2 rounded',
                          item.status === 'M' && 'text-amber-500 dark:text-amber-400 bg-amber-500/15',
                          item.status === 'A' && 'text-emerald-500 dark:text-emerald-400 bg-emerald-500/15',
                          item.status === 'D' && 'text-rose-500 dark:text-rose-400 bg-rose-500/15',
                        )}
                        title={item.status === 'M' ? 'Modified' : item.status === 'A' ? 'Added' : 'Deleted'}
                      >
                        {item.status === 'M' ? 'M↓' : item.status}
                      </span>
                    )}
                    <OfficialFileIcon filename={item.name} size={15} className="shrink-0" />
                  </div>

                  {/* Right: Filename and faint relative path */}
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-medium text-foreground/90 group-hover:text-foreground font-mono truncate">
                      {item.name}
                    </div>
                    {item.relPath && (
                      <div className="text-[10.5px] text-muted-foreground/60 font-mono truncate mt-0.2">
                        {item.relPath}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
