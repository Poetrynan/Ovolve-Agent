import React, { useMemo } from 'react'
import { FileCode, Plus, Minus } from 'lucide-react'
import { cn } from '../ui/button'

interface DiffLine {
  type: 'add' | 'del' | 'normal'
  text: string
  oldLineNumber?: number
  newLineNumber?: number
}

interface CodeDiffViewProps {
  filename?: string
  language?: string
  diffText?: string
  oldCode?: string
  newCode?: string
  className?: string
}

function parseUnifiedDiff(diff: string): { lines: DiffLine[]; added: number; removed: number } {
  const rawLines = diff.split(/\r?\n/)
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0

  for (const l of rawLines) {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')) {
      continue
    }
    if (l.startsWith('+')) {
      added++
      lines.push({ type: 'add', text: l.slice(1) })
    } else if (l.startsWith('-')) {
      removed++
      lines.push({ type: 'del', text: l.slice(1) })
    } else {
      lines.push({ type: 'normal', text: l.startsWith(' ') ? l.slice(1) : l })
    }
  }

  return { lines, added, removed }
}

export const CodeDiffView: React.FC<CodeDiffViewProps> = ({
  filename = 'source_edit.ts',
  language = 'typescript',
  diffText,
  oldCode,
  newCode,
  className = '',
}) => {
  const { lines, added, removed } = useMemo(() => {
    if (diffText) {
      return parseUnifiedDiff(diffText)
    }
    if (oldCode !== undefined || newCode !== undefined) {
      const oldLines = (oldCode || '').split(/\r?\n/)
      const newLines = (newCode || '').split(/\r?\n/)
      const res: DiffLine[] = []
      let addCount = 0
      let delCount = 0

      // Simple unified diff view
      const maxLen = Math.max(oldLines.length, newLines.length)
      for (let i = 0; i < maxLen; i++) {
        const oldL = oldLines[i]
        const newL = newLines[i]
        if (oldL !== undefined && newL !== undefined && oldL === newL) {
          res.push({ type: 'normal', text: newL, oldLineNumber: i + 1, newLineNumber: i + 1 })
        } else {
          if (oldL !== undefined) {
            delCount++
            res.push({ type: 'del', text: oldL, oldLineNumber: i + 1 })
          }
          if (newL !== undefined) {
            addCount++
            res.push({ type: 'add', text: newL, newLineNumber: i + 1 })
          }
        }
      }
      return { lines: res, added: addCount, removed: delCount }
    }
    return { lines: [], added: 0, removed: 0 }
  }, [diffText, oldCode, newCode])

  return (
    <div
      className={cn(
        'my-2.5 rounded-xl border border-border/80 dark:border-white/10 bg-card/75 dark:bg-card/45 backdrop-blur-xl shadow-2xs overflow-hidden select-text',
        className,
      )}
    >
      {/* Header Toolbar */}
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-muted/40 dark:bg-white/[0.03] border-b border-border/70 dark:border-white/10 text-[11px] font-mono select-none">
        <div className="flex items-center gap-2">
          <FileCode size={13} className="text-primary" />
          <span className="font-medium text-foreground/90">{filename}</span>
          <span className="px-1.5 py-0.2 rounded-md bg-background/80 dark:bg-white/5 border border-border/60 dark:border-white/10 text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
            {language}
          </span>
        </div>

        {/* Changes Count Badge */}
        <div className="flex items-center gap-1.5">
          {added > 0 && (
            <span className="px-1.5 py-0.2 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 text-[10px] font-bold font-mono inline-flex items-center gap-0.5">
              <Plus size={10} />
              {added}
            </span>
          )}
          {removed > 0 && (
            <span className="px-1.5 py-0.2 rounded-md bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30 text-[10px] font-bold font-mono inline-flex items-center gap-0.5">
              <Minus size={10} />
              {removed}
            </span>
          )}
        </div>
      </div>

      {/* Continuous Diff Rows */}
      <div className="overflow-x-auto text-[12px] font-mono leading-[1.6] max-h-96">
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              'px-3.5 py-0.5 whitespace-pre transition-colors flex items-start gap-3',
              l.type === 'add'
                ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 font-medium'
                : l.type === 'del'
                  ? 'bg-rose-500/10 text-rose-800 dark:text-rose-300 opacity-75 line-through font-medium'
                  : 'text-foreground/80',
            )}
          >
            <span className="w-4 text-center select-none opacity-40 font-mono text-[11px]">
              {l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}
            </span>
            <span className="flex-1">{l.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default CodeDiffView
