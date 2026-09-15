// src/components/chat/FoldMarker.tsx
// A 折痕 (fold marker) — the seam in the timeline where earlier conversation got
// compressed into a summary. Rendered as a horizontal rule with a centered pill,
// so it reads as "the transcript continues past here" rather than as a message.
//
// Collapsed by default: the summary matters to the model, not usually to the
// user. Click to read what was kept.
import { useState } from 'react'
import { ChevronDown, FoldVertical, Sparkles, Wand2, Scissors } from 'lucide-react'
import { cn } from '@lib/utils'
import type { FoldReport } from '@apptypes/index'

/** Which layer of the fold chain ran — worth showing, because quality differs. */
const STRATEGY_META: Record<
  FoldReport['strategy'],
  { label: string; icon: typeof Sparkles; hint: string }
> = {
  'llm-summary': {
    label: '模型摘要',
    icon: Sparkles,
    hint: '由模型归纳出目标 / 进展 / 决策 / 待办',
  },
  'engineering': {
    label: '规则压缩',
    icon: Wand2,
    hint: '按规则抽取关键信息，没有额外消耗',
  },
  'truncate': {
    label: '截断兜底',
    icon: Scissors,
    hint: '摘要生成失败，只保留了最近几轮',
  },
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface FoldMarkerProps {
  fold: FoldReport
}

export function FoldMarker({ fold }: FoldMarkerProps) {
  const [open, setOpen] = useState(false)
  const meta = STRATEGY_META[fold.strategy] ?? STRATEGY_META.engineering
  const Icon = meta.icon

  // 计算精简比例，例如精简 70%
  const percentSaved =
    fold.tokensBefore && fold.estimatedTokensAfter && fold.tokensBefore > fold.estimatedTokensAfter
      ? Math.round(((fold.tokensBefore - fold.estimatedTokensAfter) / fold.tokensBefore) * 100)
      : null

  return (
    <div className="animate-message-in my-3 select-none">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-border/60" />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'group inline-flex items-center gap-1.5 rounded-full border border-border/50',
            'bg-muted/40 hover:bg-muted/70 px-3 py-1 text-[11px] text-muted-foreground',
            'hover:border-border hover:text-foreground transition-all duration-200 shadow-xs cursor-pointer',
          )}
          aria-expanded={open}
        >
          <FoldVertical size={12} className="shrink-0 text-muted-foreground/80 group-hover:text-primary transition-colors" />
          <span className="font-medium text-foreground/80">
            {fold.manual ? '已将前文整理为记忆' : '早期对话已提炼为记忆'}
          </span>
          {percentSaved && percentSaved > 10 && (
            <span className="text-emerald-500/90 font-medium text-[10px]">
              (精简 {percentSaved}%)
            </span>
          )}
          <ChevronDown
            size={12}
            className={cn('shrink-0 text-muted-foreground/60 transition-transform duration-200', open && 'rotate-180')}
          />
        </button>
        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-border/60" />
      </div>

      {open && (
        <div className="mt-2.5 mx-auto max-w-2xl rounded-xl border border-border/50 bg-muted/20 backdrop-blur-xs p-3.5 shadow-sm space-y-2 animate-fade-in">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground border-b border-border/40 pb-2">
            <div className="flex items-center gap-1.5 font-medium text-foreground/80">
              <Icon size={12} className="text-primary/80" />
              <span>{meta.label}</span>
              <span className="font-normal text-muted-foreground/70 text-[10px]">（{meta.hint}）</span>
            </div>
            <div className="text-[10px] text-muted-foreground/70">
              已为后续对话腾出充足记忆空间
            </div>
          </div>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/80 font-mono bg-background/40 p-2.5 rounded-lg border border-border/30">
            {fold.summary || '（暂无结构化摘要）'}
          </pre>
        </div>
      )}
    </div>
  )
}
