import { useCallback, useEffect, useState } from 'react'
import { GitBranch, Loader2, RefreshCw, X } from 'lucide-react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { fetchGitLog } from '@lib/gitApi'
import type { GitCommitRow } from '@apptypes/index'
import { cn } from '@lib/utils'

interface GitGraphDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}

function RefPill({ name }: { name: string }) {
  const isHead = name === 'HEAD'
  const isRemote = name.startsWith('origin/')
  return (
    <span
      className={cn(
        'inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium shrink-0',
        isHead && 'bg-foreground/10 text-foreground border border-primary/30',
        !isHead && isRemote && 'bg-foreground/5 text-muted-foreground border border-border/40',
        !isHead && !isRemote && 'bg-foreground/8 text-foreground/80 border border-border/40',
      )}
    >
      {name}
    </span>
  )
}

/**
 * Near-fullscreen Git graph . Bypasses the shared DialogContent
 * ``max-w-lg`` default so a short history never collapses into a stamp.
 */
export function GitGraphDialog({ open, onOpenChange }: GitGraphDialogProps) {
  const [commits, setCommits] = useState<GitCommitRow[]>([])
  const [branch, setBranch] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const data = await fetchGitLog(120)
      setCommits(data.commits)
      setBranch(data.branch)
    } catch (e: any) {
      setErr(e?.message || '无法加载提交历史')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            'fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border/40 bg-background shadow-2xl',
            'outline-none data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
          style={{
            // Explicit geometry — don't fight Tailwind max-w-lg / grid defaults.
            left: '4vw',
            top: '5vh',
            width: '92vw',
            height: '90vh',
            maxWidth: '92vw',
            maxHeight: '90vh',
          }}
        >
          <div className="flex items-center gap-2 px-5 py-3.5 border-b border-border/20 shrink-0">
            <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
            <DialogPrimitive.Title className="text-sm font-heading font-semibold flex-1">
              Git 图谱
            </DialogPrimitive.Title>
            {branch && (
              <span className="text-[11px] text-muted-foreground font-mono">{branch}</span>
            )}
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {commits.length > 0 ? `${commits.length} 条` : ''}
            </span>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              aria-label="刷新"
              className="h-8 w-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </button>
            <DialogPrimitive.Close
              aria-label="关闭"
              className="h-8 w-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="flex-1 overflow-auto min-h-0">
            {err && (
              <p className="px-5 py-4 text-sm text-destructive">{err}</p>
            )}
            {!err && (
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-[1] bg-card/95 backdrop-blur-sm border-b border-border/20">
                  <tr className="text-muted-foreground text-left text-xs">
                    <th className="w-16 px-5 py-3 font-medium">图</th>
                    <th className="px-5 py-3 font-medium">描述</th>
                    <th className="w-36 px-5 py-3 font-medium">日期</th>
                    <th className="w-40 px-5 py-3 font-medium">作者</th>
                    <th className="w-28 px-5 py-3 font-medium">提交</th>
                  </tr>
                </thead>
                <tbody>
                  {commits.map((c, i) => (
                    <tr
                      key={c.hash}
                      className="border-b border-border/10 hover:bg-foreground/[0.04] transition-colors"
                    >
                      <td className="px-5 py-3.5 align-middle">
                        <div className="relative flex items-center justify-center h-8">
                          {i < commits.length - 1 && (
                            <span className="absolute top-1/2 left-1/2 -translate-x-1/2 w-px h-8 bg-border/70" />
                          )}
                          <span
                            className={cn(
                              'relative z-[1] w-3.5 h-3.5 rounded-full border-2',
                              c.isHead
                                ? 'border-primary bg-accent'
                                : 'border-muted-foreground/50 bg-background',
                            )}
                          />
                        </div>
                      </td>
                      <td className="px-5 py-3.5 align-middle">
                        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                          {c.refs.map((r) => (
                            <RefPill key={`${c.hash}-${r}`} name={r} />
                          ))}
                          <span className="text-foreground/90">{c.subject}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground tabular-nums whitespace-nowrap">
                        {formatDate(c.date)}
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground truncate max-w-[10rem]">
                        {c.author}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-muted-foreground">
                        {c.shortHash}
                      </td>
                    </tr>
                  ))}
                  {!loading && commits.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-24 text-center text-muted-foreground">
                        暂无提交记录
                      </td>
                    </tr>
                  )}
                  {!loading && commits.length > 0 && commits.length < 8 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-16 text-center text-[11px] text-muted-foreground/60">
                        当前仓库提交较少；后续提交会显示在此时间线中
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
