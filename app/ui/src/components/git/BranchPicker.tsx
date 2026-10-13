import { useEffect, useMemo, useState } from 'react'
import { Check, GitBranch, GitFork, Loader2, Plus, Search, Upload } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@components/ui/dropdown-menu'
import { useGitStore } from '@store/gitStore'
import { CreateBranchDialog } from './CreateBranchDialog'
import { GitGraphDialog } from './GitGraphDialog'
import { CommitDialog } from './CommitDialog'
import { cn } from '@lib/utils'

export function BranchPicker() {
  const { status, branches, loading, refresh, checkout } = useGitStore()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => refresh(), 12_000)
    return () => window.clearInterval(id)
  }, [refresh])

  // 这些是纯派生值，不是 hook，放在 early return 之前没问题。
  const branch = status?.branch || '…'
  const dirty = status?.status === 'dirty'
  const changeCount = status?.changes?.length ?? 0
  const ahead = status?.ahead || 0
  const behind = status?.behind || 0

  // useMemo 必须留在 early return 之上。首帧 status 还是 null，条件不成立、
  // 全部 hook 都跑；等 refresh() 回来发现不是 git 仓库才提前 return——那一帧
  // 少跑一个 hook，React 就报 "Rendered fewer hooks than expected"。
  // Hook 调用必须无条件，派生数据可以有条件。
  const filtered = useMemo(() => {
    const list = branches.length ? branches : (branch !== '…' ? [branch] : [])
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(b => b.toLowerCase().includes(q))
  }, [branches, branch, query])

  if (status && !status.isGitRepository) {
    return null
  }

  const onSelect = async (name: string) => {
    if (name === branch || busy) return
    setBusy(true)
    setErr(null)
    try {
      await checkout(name)
    } catch (e: any) {
      setErr(e?.message || '切换失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DropdownMenu onOpenChange={(open) => {
        if (open) {
          void refresh()
          setQuery('')
          setErr(null)
        }
      }}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs',
              'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
              'transition-colors duration-150 ease-out press-feedback',
            )}
            aria-label="选择 Git 分支"
          >
            {(loading || busy) ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="h-3.5 w-3.5" />
            )}
            <span className="font-medium text-foreground/90 max-w-[9rem] truncate">{branch}</span>
            {dirty && <span className="w-1.5 h-1.5 rounded-full bg-warning" title="有未提交改动" />}
            {(ahead > 0 || behind > 0) && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {ahead > 0 && `↑${ahead}`}
                {behind > 0 && ` ↓${behind}`}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-72 p-0" onCloseAutoFocus={(e) => e.preventDefault()}>
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border/20">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索分支"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground px-3 pt-2 pb-1">
            分支
          </DropdownMenuLabel>

          {err && (
            <p className="px-3 pb-1.5 text-[11px] text-destructive leading-snug">{err}</p>
          )}

          <div className="max-h-52 overflow-y-auto px-1 pb-1">
            {filtered.map((name) => {
              const isCurrent = name === branch
              return (
                <DropdownMenuItem
                  key={name}
                  onClick={() => void onSelect(name)}
                  className={cn(
                    'text-xs gap-2 flex-col items-stretch py-2 cursor-pointer',
                    isCurrent && 'bg-muted',
                  )}
                  disabled={busy}
                >
                  <div className="flex items-center gap-2 w-full">
                    <span className="font-medium truncate flex-1 text-foreground">{name}</span>
                    <Check className={cn('h-3.5 w-3.5 shrink-0 text-foreground', isCurrent ? 'opacity-100' : 'opacity-0')} />
                  </div>
                  {isCurrent && dirty && changeCount > 0 && (
                    <span className="text-[10px] text-foreground/65 pl-0">
                      未提交的更改：{changeCount} 个文件
                    </span>
                  )}
                </DropdownMenuItem>
              )
            })}
            {filtered.length === 0 && (
              <p className="px-3 py-3 text-[11px] text-muted-foreground">没有匹配的分支</p>
            )}
          </div>

          <DropdownMenuSeparator className="my-0" />

          <DropdownMenuItem
            className="text-xs gap-2 rounded-none py-2.5 cursor-pointer"
            onSelect={(e) => {
              e.preventDefault()
              setCommitOpen(true)
            }}
            disabled={!dirty}
          >
            <Upload className="h-3.5 w-3.5" />
            提交或推送…
            {dirty && changeCount > 0 && (
              <span className="ml-auto tabular-nums text-[10px]">
                <span className="text-success">+{status?.additions ?? 0}</span>{' '}
                <span className="text-destructive">-{status?.deletions ?? 0}</span>
              </span>
            )}
          </DropdownMenuItem>

          <DropdownMenuItem
            className="text-xs gap-2 rounded-none py-2.5 cursor-pointer"
            onSelect={(e) => {
              e.preventDefault()
              setCreateOpen(true)
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            创建并检出新分支…
          </DropdownMenuItem>

          <DropdownMenuItem
            className="text-xs gap-2 rounded-none py-2.5 cursor-pointer"
            onSelect={(e) => {
              e.preventDefault()
              setGraphOpen(true)
            }}
          >
            <GitFork className="h-3.5 w-3.5" />
            Git 图谱
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateBranchDialog open={createOpen} onOpenChange={setCreateOpen} />
      <GitGraphDialog open={graphOpen} onOpenChange={setGraphOpen} />
      <CommitDialog open={commitOpen} onOpenChange={setCommitOpen} />
    </>
  )
}
