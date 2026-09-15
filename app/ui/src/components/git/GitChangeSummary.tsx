import { useState } from 'react'
import { Check, ChevronRight, FileDiff, RotateCcw } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@components/ui/alert-dialog'
import { useGitStore } from '@store/gitStore'
import { useSidePanelStore } from '@store/sidePanelStore'
import { fetchGitDiff } from '@lib/gitApi'
import { OfficialFileIcon } from '@components/ui/OfficialFileIcon'
import { CommitDialog } from './CommitDialog'
import { cn } from '@lib/utils'

function getStatusBadge(kind: string) {
  switch (kind) {
    case 'modified':
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono text-amber-500 bg-amber-500/10 border border-amber-500/20 shrink-0">
          M
        </span>
      )
    case 'added':
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 shrink-0">
          A
        </span>
      )
    case 'untracked':
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 shrink-0">
          ?
        </span>
      )
    case 'deleted':
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono text-rose-500 bg-rose-500/10 border border-rose-500/20 shrink-0">
          D
        </span>
      )
    case 'renamed':
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono text-sky-500 bg-sky-500/10 border border-sky-500/20 shrink-0">
          R
        </span>
      )
    case 'copied':
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono text-cyan-500 bg-cyan-500/10 border border-cyan-500/20 shrink-0">
          C
        </span>
      )
    default:
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono text-muted-foreground bg-muted border border-border/40 shrink-0">
          {kind[0]?.toUpperCase() || 'M'}
        </span>
      )
  }
}

/**
 * Summary bar: "N 个文件已更改 +X -Y" + 撤销.
 * Shown when the working tree is dirty.
 */
export function GitChangeSummary({
  className,
  compact = false,
}: {
  className?: string
  /** Stickier, denser row for above the input. */
  compact?: boolean
}) {
  const { status, restore, refresh } = useGitStore()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)

  if (!status?.isGitRepository || status.status !== 'dirty') return null

  const changes = status.changes ?? []
  const count = changes.length
  if (count === 0) return null

  const additions = status.additions ?? 0
  const deletions = status.deletions ?? 0

  const onUndo = async () => {
    setBusy(true)
    setErr(null)
    try {
      await restore()
      await refresh()
    } catch (e: any) {
      setErr(e?.message || '撤销失败')
    } finally {
      setBusy(false)
    }
  }

  const handleOpenFile = async (fileRelPath: string) => {
    try {
      const res = await fetchGitDiff(fileRelPath)
      const allFiles = (changes || []).map((ch) => {
        const parts = ch.path.replace(/\\/g, '/').split('/')
        const fname = parts[parts.length - 1] || ch.path
        return {
          filename: fname,
          filePath: ch.path,
          added: ch.additions,
          removed: ch.deletions,
        }
      })
      const parts = fileRelPath.replace(/\\/g, '/').split('/')
      const fname = parts[parts.length - 1] || fileRelPath

      useSidePanelStore.getState().openEditor({
        filename: fname,
        filePath: fileRelPath,
        diff: res.diff,
        targetContent: res.targetContent,
        replacementContent: res.replacementContent,
        added: res.additions,
        removed: res.deletions,
        allFiles,
      })
    } catch {
      const parts = fileRelPath.replace(/\\/g, '/').split('/')
      const fname = parts[parts.length - 1] || fileRelPath
      useSidePanelStore.getState().openEditor({
        filename: fname,
        filePath: fileRelPath,
        content: '',
      })
    }
  }

  return (
    <>
    <div
      className={cn(
        'rounded-xl border border-border/40 bg-card/80 backdrop-blur-sm animate-message-in',
        compact ? 'px-3 py-2' : 'px-3 py-2.5',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left press-feedback cursor-pointer"
          aria-expanded={expanded}
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
          <FileDiff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-foreground/90 shrink-0 font-medium">{count} 个文件已更改</span>
          <span className="tabular-nums shrink-0 font-mono text-[11.5px]">
            <span className="text-success font-semibold">+{additions}</span>
            {' '}
            <span className="text-destructive font-semibold">-{deletions}</span>
          </span>
          {err && <span className="text-destructive text-[11px] truncate">{err}</span>}
        </button>

        <button
          type="button"
          onClick={() => setCommitOpen(true)}
          disabled={busy}
          title="填写或自动生成提交信息，然后提交 / 提交并推送"
          className={cn(
            'inline-flex items-center gap-1 h-7 px-2.5 rounded-lg shrink-0 cursor-pointer',
            'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
            'transition-colors duration-150 press-feedback disabled:opacity-50',
          )}
        >
          <Check className="h-3 w-3" />
          提交…
        </button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              disabled={busy}
              className={cn(
                'inline-flex items-center gap-1 h-7 px-2.5 rounded-lg shrink-0 cursor-pointer',
                'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
                'transition-colors duration-150 press-feedback disabled:opacity-50',
              )}
            >
              <RotateCcw className="h-3 w-3" />
              撤销
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>撤销未提交改动？</AlertDialogTitle>
              <AlertDialogDescription>
                将把工作区与暂存区恢复到当前 HEAD（{count} 个文件）。此操作不可恢复，已提交的历史不受影响。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={onUndo}>确认撤销</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {expanded && (
        <ul className="mt-2.5 pt-2 border-t border-border/20 space-y-1 max-h-56 overflow-y-auto">
          {changes.slice(0, 50).map((c) => {
            const clean = c.path.replace(/\\/g, '/')
            const lastSlash = clean.lastIndexOf('/')
            const filename = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean
            const dirPath = lastSlash >= 0 ? clean.slice(0, lastSlash + 1) : ''

            return (
              <li key={`${c.path}-${c.kind}-${c.staged}`}>
                <button
                  type="button"
                  onClick={() => handleOpenFile(c.path)}
                  className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-foreground/5 dark:hover:bg-white/[0.06] cursor-pointer transition-colors group border border-transparent hover:border-border/40"
                  title={`点击在右侧查看 ${c.path} 的改动差异`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {getStatusBadge(c.kind)}
                    <OfficialFileIcon filename={filename} size={15} className="shrink-0" />
                    <span className="text-[12px] font-medium text-foreground group-hover:text-primary transition-colors truncate">
                      {filename}
                    </span>
                    {dirPath && (
                      <span className="text-[10.5px] text-muted-foreground/60 font-mono truncate hidden sm:inline">
                        {dirPath}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0 tabular-nums font-mono text-[11px]">
                    {c.staged && (
                      <span className="text-[9.5px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium border border-emerald-500/20 shrink-0">
                        staged
                      </span>
                    )}
                    {c.additions !== undefined && c.additions > 0 && (
                      <span className="text-emerald-500 font-semibold">+{c.additions}</span>
                    )}
                    {c.deletions !== undefined && c.deletions > 0 && (
                      <span className="text-rose-500 font-semibold">-{c.deletions}</span>
                    )}
                  </div>
                </button>
              </li>
            )
          })}
          {changes.length > 50 && (
            <li className="px-2.5 py-1 text-[11px] text-muted-foreground/70">…还有 {changes.length - 50} 个文件</li>
          )}
        </ul>
      )}
    </div>

    <CommitDialog open={commitOpen} onOpenChange={setCommitOpen} />
    </>
  )
}
