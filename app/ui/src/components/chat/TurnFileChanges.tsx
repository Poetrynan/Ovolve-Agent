// src/components/chat/TurnFileChanges.tsx
//
// What this turn changed on disk, shown under the reply rather than inside the
// activity feed. The feed narrates the process — read, search, edit, run — and
// is the right place to watch a turn while it is working. The files a turn
// changed are not part of that narrative: they are the outcome, and the reader
// wants them after reading the answer. Keeping the summary in the feed also
// buried it above the reply text on settled turns.
import { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@lib/utils'
import { fetchGitDiff } from '@lib/gitApi'
import { useSidePanelStore } from '@store/sidePanelStore'
import { OfficialFileIcon } from '@components/ui/OfficialFileIcon'
import { changedFilesForTurn, type ChangedFile } from '@lib/turnChanges'
import type { ToolCall } from '@apptypes/index'

const ACTION_LABEL: Record<ChangedFile['action'], string> = {
  created: '新建',
  edited: '编辑',
  deleted: '删除',
  moved: '移动',
  copied: '复制',
}

interface TurnFileChangesProps {
  toolCalls: ToolCall[]
  className?: string
}

export function TurnFileChanges({ toolCalls, className }: TurnFileChangesProps) {
  const changes = useMemo(() => changedFilesForTurn(toolCalls), [toolCalls])
  const files = changes.files
  if (files.length === 0) return null

  const openFile = async (file: ChangedFile) => {
    const allFiles = files.map((f) => ({
      filename: f.name,
      filePath: f.path,
      added: f.added,
      removed: f.removed,
    }))
    try {
      // The editor shows the working-tree diff, so it always reflects the file
      // as it is now — including edits a later turn made.
      const diff = await fetchGitDiff(file.path)
      useSidePanelStore.getState().openEditor({
        filename: file.name,
        filePath: file.path,
        diff: diff.diff,
        targetContent: diff.targetContent,
        replacementContent: diff.replacementContent,
        added: diff.additions,
        removed: diff.deletions,
        allFiles,
      })
    } catch {
      // No diff available (untracked, deleted, or outside the repo) — the Git
      // panel can still say what happened, and it beats a blank editor.
      useSidePanelStore.getState().openTab('git')
    }
  }

  const total =
    changes.added !== null && changes.removed !== null
      ? { added: changes.added, removed: changes.removed }
      : null

  return (
    <div
      className={cn(
        'rounded-xl border border-border/80 dark:border-white/15 bg-card/85 dark:bg-card/50',
        'backdrop-blur-xl shadow-xs ring-1 ring-black/[0.03] dark:ring-white/[0.05]',
        'transition-colors hover:border-primary/50',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => void openFile(files[files.length - 1])}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left cursor-pointer group select-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-foreground/90 group-hover:text-primary transition-colors shrink-0">
            本轮改动 {files.length} 个文件
          </span>
          {total && (
            <span className="font-mono text-[10.5px] tabular-nums shrink-0">
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">+{total.added}</span>{' '}
              <span className="text-rose-600 dark:text-rose-400 font-semibold">-{total.removed}</span>
            </span>
          )}
        </div>
        <span className="flex items-center gap-1 text-muted-foreground/70 group-hover:text-primary transition-colors text-[11.5px] shrink-0">
          查看差异
          <ChevronRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
        </span>
      </button>

      {files.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pt-0.5 border-t border-border/30">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => void openFile(file)}
              title={`${ACTION_LABEL[file.action]} · ${file.path}`}
              className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted/60 hover:bg-muted text-foreground/85 text-[11px] font-mono border border-border/50 hover:border-primary/40 transition-all cursor-pointer shadow-2xs"
            >
              <OfficialFileIcon filename={file.name} size={12} />
              <span className="truncate max-w-[140px]">{file.name}</span>
              {file.added !== undefined && file.added > 0 && (
                <span className="text-[9.5px] tabular-nums font-mono text-emerald-500 font-semibold">+{file.added}</span>
              )}
              {file.removed !== undefined && file.removed > 0 && (
                <span className="text-[9.5px] tabular-nums font-mono text-rose-500 font-semibold">-{file.removed}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
