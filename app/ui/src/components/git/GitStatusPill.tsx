// src/components/git/GitStatusPill.tsx
// The ONE ambient git indicator in the header: branch, change count and the
// +/− line diff, with the changed-file list on hover.
//
// It is a shortcut, not a control — clicking goes to the Git side panel, which
// is the single home for branch switching, the change list, commit/push and the
// graph. This deliberately replaces the header BranchPicker so git status lives
// in exactly one header slot instead of three overlapping ones.
//
// It also no longer vanishes when there is nothing to report. Returning null
// for a closed workspace left the header silently empty, which reads as "this
// build has no git integration" rather than "you haven't opened a folder" — and
// the way out was nowhere near the eye. Each state now names itself and its
// click target follows from it.
import { FolderOpen, GitBranch } from 'lucide-react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@components/ui/tooltip'
import { useGitStore } from '@store/gitStore'
import { useSidePanelStore } from '@store/sidePanelStore'
import { fetchGitDiff } from '@lib/gitApi'
import { OfficialFileIcon } from '@components/ui/OfficialFileIcon'
import { cn } from '@lib/utils'

function getStatusBadge(kind: string) {
  switch (kind) {
    case 'modified':
      return (
        <span className="px-1 py-0.2 rounded text-[9.5px] font-bold font-mono text-amber-500 bg-amber-500/10 border border-amber-500/20 shrink-0">
          M
        </span>
      )
    case 'added':
      return (
        <span className="px-1 py-0.2 rounded text-[9.5px] font-bold font-mono text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 shrink-0">
          A
        </span>
      )
    case 'untracked':
      return (
        <span className="px-1 py-0.2 rounded text-[9.5px] font-bold font-mono text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 shrink-0">
          ?
        </span>
      )
    case 'deleted':
      return (
        <span className="px-1 py-0.2 rounded text-[9.5px] font-bold font-mono text-rose-500 bg-rose-500/10 border border-rose-500/20 shrink-0">
          D
        </span>
      )
    case 'renamed':
      return (
        <span className="px-1 py-0.2 rounded text-[9.5px] font-bold font-mono text-sky-500 bg-sky-500/10 border border-sky-500/20 shrink-0">
          R
        </span>
      )
    case 'copied':
      return (
        <span className="px-1 py-0.2 rounded text-[9.5px] font-bold font-mono text-cyan-500 bg-cyan-500/10 border border-cyan-500/20 shrink-0">
          C
        </span>
      )
    default:
      return (
        <span className="px-1 py-0.2 rounded text-[9.5px] font-bold font-mono text-muted-foreground bg-muted border border-border/40 shrink-0">
          {kind[0]?.toUpperCase() || 'M'}
        </span>
      )
  }
}

/** Files listed in the hover card before it starts counting the remainder. */
const VISIBLE_FILES = 12

interface Props {
  /** Opens the Git side panel (the real git home). */
  onOpenPanel?: () => void
  /** Opens the Files panel, which owns the folder picker. */
  onOpenFiles?: () => void
  className?: string
}

export function GitStatusPill({ onOpenPanel, onOpenFiles, className }: Props) {
  const { status } = useGitStore()

  // `null` means the first fetch hasn't landed yet. Render nothing rather than
  // flashing 「未打开工作区」 for one round-trip and then contradicting it.
  if (!status) return null

  const workspaceOpen = status.workspaceOpen !== false
  const isRepo = status.isGitRepository
  const changes = status.changes ?? []
  const count = changes.length
  const additions = status.additions ?? 0
  const deletions = status.deletions ?? 0
  const dirty = isRepo && status.status === 'dirty' && count > 0

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

  const base = cn(
    'inline-flex items-center gap-1.5 h-7 px-2 rounded-lg shrink-0 text-[11px]',
    'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
    'transition-colors duration-150 press-feedback',
    className,
  )

  if (!workspaceOpen) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpenFiles}
            className={base}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span>未打开工作区</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>尚未打开项目文件夹 · 点击打开文件面板</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  if (!isRepo) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpenPanel}
            className={base}
          >
            <GitBranch className="h-3.5 w-3.5" />
            <span>非 Git 仓库</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>当前工作区不在 Git 仓库中 · 点击打开 Git 面板</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  const branch = status.branch ?? 'HEAD'
  const pill = (
    <button
      type="button"
      onClick={onOpenPanel}
      className={base}
    >
      <GitBranch className="h-3.5 w-3.5" />
      <span className="font-medium text-foreground/90 max-w-[120px] truncate">{branch}</span>
      {dirty ? (
        <>
          <span className="w-1.5 h-1.5 rounded-full bg-warning" />
          <span className="tabular-nums">{count} 文件</span>
          <span className="tabular-nums font-mono">
            <span className="text-success">+{additions}</span>
            {' '}
            <span className="text-destructive">−{deletions}</span>
          </span>
        </>
      ) : (
        <span className="opacity-70">无改动</span>
      )}
    </button>
  )

  // The list only exists when something changed, so a clean tree keeps the bare
  // pill wrapped in a styled Tooltip matching adjacent header buttons.
  if (!dirty) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {pill}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>工作区干净 · 点击打开 Git 面板</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>{pill}</HoverCardTrigger>
      <HoverCardContent align="end" sideOffset={6} className="w-[320px] p-2.5 space-y-2">
        <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
          <span className="text-foreground/90 font-medium">{count} 个文件已更改</span>
          <span className="tabular-nums font-mono">
            <span className="text-success font-semibold">+{additions}</span>
            {' '}
            <span className="text-destructive font-semibold">−{deletions}</span>
          </span>
        </div>

        <ul className="space-y-1 max-h-[220px] overflow-y-auto">
          {changes.slice(0, VISIBLE_FILES).map((c) => {
            const clean = c.path.replace(/\\/g, '/')
            const lastSlash = clean.lastIndexOf('/')
            const filename = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean
            const dirPath = lastSlash >= 0 ? clean.slice(0, lastSlash + 1) : ''

            return (
              <li key={`${c.path}-${c.kind}-${c.staged}`}>
                <button
                  type="button"
                  onClick={() => handleOpenFile(c.path)}
                  className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-foreground/5 dark:hover:bg-white/[0.06] cursor-pointer transition-colors group border border-transparent hover:border-border/40"
                  title={`点击在右侧查看 ${c.path} 的改动差异`}
                >
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    {getStatusBadge(c.kind)}
                    <OfficialFileIcon filename={filename} size={14} className="shrink-0" />
                    <span className="text-[11.5px] font-medium text-foreground group-hover:text-primary transition-colors truncate">
                      {filename}
                    </span>
                    {dirPath && (
                      <span className="text-[10px] text-muted-foreground/60 font-mono truncate hidden sm:inline">
                        {dirPath}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 tabular-nums font-mono text-[10.5px]">
                    {c.staged && (
                      <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-500/10 text-emerald-500 font-medium border border-emerald-500/20 shrink-0">
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
        </ul>

        {count > VISIBLE_FILES && (
          <div className="text-[10.5px] text-muted-foreground/70 px-1">
            …还有 {count - VISIBLE_FILES} 个文件
          </div>
        )}

        <button
          type="button"
          onClick={onOpenPanel}
          className="w-full pt-1.5 border-t border-border/30 text-[10.5px] text-muted-foreground/80 hover:text-primary transition-colors text-left cursor-pointer"
        >
          点击打开完整 Git 面板 →
        </button>
      </HoverCardContent>
    </HoverCard>
  )
}
