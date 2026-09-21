/**
 * DiffBlock — renders a ```diff fenced block as a real red/green hunk instead
 * of monochrome text.
 *
 * Why a hand-rolled parser instead of diff2html: we only need unified-diff
 * *display*, not diff computation, side-by-side mode, or file-tree grouping.
 * A parser this small (one pass, five line-kinds) stays inside our own colour
 * tokens, so a diff in a chat bubble matches the diff badge on a tool card —
 * which matters more than feature breadth, because the user is comparing the
 * two on the same screen.
 *
 * Recognised line kinds:
 *   `+ …`          addition
 *   `- …`          deletion
 *   `@@ … @@`      hunk header
 *   `+++ / ---`    file header (NOT counted as add/delete — the classic bug
 *                  in naive diff colourisers, which paints them green/red and
 *                  inflates every diff by two lines)
 *   anything else  context
 */
import { useMemo } from 'react'
import { cn } from '@/lib/utils'

type LineKind = 'add' | 'del' | 'hunk' | 'file' | 'context'

interface DiffLine {
  kind: LineKind
  text: string
}

function classify(line: string): LineKind {
  // Order matters: file headers start with +++/--- so they must be tested
  // BEFORE the single +/- checks.
  if (line.startsWith('+++') || line.startsWith('---')) return 'file'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

const LINE_STYLE: Record<LineKind, string> = {
  add: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 font-medium',
  del: 'bg-rose-500/10 text-rose-800 dark:text-rose-300 font-medium opacity-80',
  hunk: 'text-sky-600 dark:text-sky-400 bg-sky-500/8 font-bold',
  file: 'text-muted-foreground/80 font-bold',
  context: 'text-foreground/80',
}

export function DiffBlock({ source }: { source: string }) {
  const { lines, added, removed } = useMemo(() => {
    const raw = source.replace(/\n$/, '').split('\n')
    const parsed: DiffLine[] = raw.map((text) => ({ kind: classify(text), text }))
    return {
      lines: parsed,
      added: parsed.filter((l) => l.kind === 'add').length,
      removed: parsed.filter((l) => l.kind === 'del').length,
    }
  }, [source])

  return (
    <div className="my-2.5 rounded-xl border border-border/80 dark:border-white/10 bg-card/75 dark:bg-card/45 backdrop-blur-xl shadow-2xs overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-1.5 bg-muted/40 dark:bg-white/[0.03] border-b border-border/70 dark:border-white/10 text-[11px] font-mono select-none">
        <span className="px-1.5 py-0.5 rounded-md bg-background/80 dark:bg-white/5 border border-border/60 dark:border-white/10 text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
          diff
        </span>
        <div className="flex items-center gap-1.5 ml-auto">
          {added > 0 && (
            <span className="px-1.5 py-0.2 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 text-[10px] font-bold font-mono">
              +{added}
            </span>
          )}
          {removed > 0 && (
            <span className="px-1.5 py-0.2 rounded-md bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30 text-[10px] font-bold font-mono">
              −{removed}
            </span>
          )}
        </div>
      </div>
      <div className="overflow-x-auto text-[12px] leading-relaxed font-mono py-1">
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn('px-3.5 py-0.5 whitespace-pre', LINE_STYLE[l.kind])}
          >
            {l.text || ' '}
          </div>
        ))}
      </div>
    </div>
  )
}
