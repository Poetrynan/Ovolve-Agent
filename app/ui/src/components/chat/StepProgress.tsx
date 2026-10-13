/**
 * StepProgress.tsx — Current turn step progress indicator.
 *
 * Shows structured progress for multi-step tasks (goals, plans, long agent loops).
 * Pattern: mirror FoldMarker (horizontal divider + center pill + expandable panel).
 *
 * Props:
 *   steps: total number of steps
 *   current: current step index (1-based)
 *   phase: current phase label (e.g. "coding", "testing", "reviewing")
 *   tool: optional tool name being used in current step
 *   perStepLabels: optional array of step labels
 */
import { useState } from 'react'
import { ChevronDown, ListChecks, Loader2, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  steps: number
  current: number
  phase?: string
  tool?: string
  perStepLabels?: string[]
}

const PHASE_LABELS: Record<string, string> = {
  thinking: '思考中',
  planning: '规划中',
  coding: '编写代码',
  editing: '编辑文件',
  testing: '运行测试',
  reviewing: '审查结果',
  verifying: '验证中',
  folding: '整理上下文',
  waiting: '等待中',
}

export function StepProgress({ steps, current, phase, tool, perStepLabels }: Props) {
  const [open, setOpen] = useState(false)
  const pct = Math.min(100, Math.round((current / steps) * 100))
  const phaseLabel = PHASE_LABELS[phase || ''] || phase || '执行中'

  return (
    <div className="animate-message-in my-1">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-border" />
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 rounded-full border border-border/50 bg-muted/30 px-3 py-1 text-xs transition-colors hover:bg-muted/50"
        >
          {current >= steps ? (
            <CheckCircle2 size={12} className="text-emerald-500" />
          ) : (
            <Loader2 size={12} className="animate-spin text-blue-500" />
          )}
          <span className="font-medium">
            {current >= steps ? '全部完成' : `第 ${current}/${steps} 步`}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{phaseLabel}</span>
          {tool && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="max-w-[120px] truncate text-muted-foreground">{tool}</span>
            </>
          )}
          <ChevronDown
            size={10}
            className={cn('text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        </button>
        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-border" />
      </div>

      {open && (
        <div className="mt-2 rounded-xl border border-border/50 bg-muted/20 p-3">
          {/* Progress bar */}
          <div className="mb-2.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border/30">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  current >= steps ? 'bg-emerald-500' : 'bg-blue-500'
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs font-medium tabular-nums">{pct}%</span>
          </div>

          {/* Step list */}
          <div className="space-y-1">
            {Array.from({ length: steps }, (_, i) => {
              const stepNum = i + 1
              const isDone = stepNum < current
              const isCurrent = stepNum === current
              const label = perStepLabels?.[i] || `步骤 ${stepNum}`
              return (
                <div
                  key={i}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1 text-xs',
                    isCurrent && 'bg-blue-500/10 font-medium',
                    isDone && 'text-muted-foreground'
                  )}
                >
                  {isDone ? (
                    <CheckCircle2 size={11} className="text-emerald-500" />
                  ) : isCurrent ? (
                    <Loader2 size={11} className="animate-spin text-blue-500" />
                  ) : (
                    <span className="inline-block h-2 w-2 rounded-full bg-border" />
                  )}
                  <span className={cn(isDone && 'line-through opacity-60')}>{label}</span>
                  {isCurrent && phaseLabel && (
                    <span className="ml-auto text-blue-500">{phaseLabel}</span>
                  )}
                </div>
              )
            })}
          </div>

          {tool && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ListChecks size={11} />
              <span>当前工具: {tool}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
