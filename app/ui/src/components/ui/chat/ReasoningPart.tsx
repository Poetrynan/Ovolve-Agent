/**
 * ReasoningPart — collapsible "thinking" block (TOOL_UI_UX.md §2.2).
 *
 * Reasoning-capable models (LongCat-2.0, GLM, DeepSeek-R1) emit a hidden chain
 * of thought in the ``reasoning_content`` field. We surface it as a panel that
 * behaves differently depending on whether the model is still thinking:
 *
 *   · thinking  — auto-expanded, auto-scrolled to the newest line, live timer.
 *                 A 30s silent wait reads as a hang; watching it type does not.
 *   · finished  — auto-collapses to "已深度思考 · 3.8s" so the answer is the
 *                 focus. Still clickable if the user wants to read it.
 *
 * Manual clicks always win: once the user has opened or closed it by hand, we
 * stop auto-managing that block.
 */
import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ReasoningPartProps {
  text: string
  /** 1-based step index within the turn. */
  step?: number
  /** Whether this block was the final reasoning (no follow-up tool calls). */
  final?: boolean
  defaultExpanded?: boolean
  /** True while deltas are still arriving for this block. */
  streaming?: boolean
  /** Epoch ms when this reasoning block started. Enables the duration read-out. */
  startedAt?: number
  /** Epoch ms when it finished. Absent while streaming. */
  endedAt?: number
}

/** "4.2s" / "1m 12s" — a duration the user can actually parse at a glance. */
function fmtDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

export function ReasoningPart({
  text,
  step,
  final,
  defaultExpanded = false,
  streaming = false,
  startedAt,
  endedAt,
}: ReasoningPartProps) {
  // `null` = still following the auto policy; a boolean = user took control.
  const [manual, setManual] = useState<boolean | null>(
    defaultExpanded ? true : null,
  )
  const expanded = manual ?? streaming

  // Live timer, only ticking while streaming. Stops the moment thinking ends,
  // so a finished block shows a stable number instead of counting forever.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!streaming) return
    const t = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(t)
  }, [streaming])

  // Keep the newest line in view while the CoT types itself out.
  const bodyRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (streaming && expanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [text, streaming, expanded])

  if (!text && !streaming) return null

  const elapsed =
    startedAt != null ? (endedAt ?? (streaming ? now : startedAt)) - startedAt : null

  return (
    <div
      className={cn(
        'rounded-xl border text-xs transition-all duration-200 overflow-hidden',
        streaming
          ? 'border-primary/40 bg-card/60 shadow-xs ring-1 ring-primary/20'
          : 'border-border/40 bg-muted/20 hover:bg-muted/30',
      )}
    >
      <button
        type="button"
        onClick={() => setManual(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left select-none transition-colors"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out-strong',
            expanded && 'rotate-90',
          )}
        />
        {streaming ? (
          <div className="relative flex items-center justify-center">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          </div>
        ) : (
          <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
        )}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={cn('font-medium', streaming ? 'text-foreground font-semibold' : 'text-muted-foreground')}>
            {streaming ? '正在深度思考' : '已完成深度思考'}
          </span>
          {typeof step === 'number' && (
            <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-muted text-muted-foreground font-mono">
              第 {step + 1} 步
            </span>
          )}
          {!streaming && final && (
            <span className="text-[10px] text-muted-foreground/70">
              · 最终
            </span>
          )}
        </div>
        {elapsed != null && elapsed > 200 && (
          <span className="text-[11px] font-mono text-muted-foreground/70 tabular-nums ml-1">
            · {fmtDuration(elapsed)}
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground/60 hover:text-foreground">
          {expanded ? '收起' : '展开'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/30 bg-background/50 px-3.5 py-2.5">
          <pre
            ref={bodyRef}
            className="font-sans text-[11.5px] leading-relaxed text-muted-foreground/90 whitespace-pre-wrap break-words max-h-64 overflow-y-auto pr-1 selection:bg-primary/20"
          >
            {text}
            {streaming && (
              <span className="inline-block w-1.5 h-3.5 ml-1 bg-primary/70 animate-pulse align-middle" />
            )}
          </pre>
        </div>
      )}
    </div>
  )
}
