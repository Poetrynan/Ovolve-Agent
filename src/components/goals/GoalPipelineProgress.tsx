// src/components/goals/GoalPipelineProgress.tsx
// 目标流水线阶段条（P1-4 子项二，G10）。
//
// 数据源口径见 lib/goalStages.ts：P1-4 已接线，后端 goal_scheduler 在
// plan→execute→verify 切换点经 goal_state_change 补发细粒度 `stage` 字段
// （goalStore.applyStateChange 落到 goal.stage），本组件经 deriveGoalStages
// 消费真实事件；事件不带 stage 时按 status 诚实推导——排队/规划/执行/验证/
// 完成，当前阶段高亮、走过的阶段打勾，绝不虚构进度。
//
// mock 演示路径：createMockStageEventStream + foldStageEvents（见 lib），
// 供单测与预览；生产渲染走 deriveGoalStages(goal)。
import { Check, AlertCircle, CircleDashed, Loader2, Pause } from 'lucide-react'
import { cn } from '../../lib/utils'
import { deriveGoalStages, type GoalStage, type GoalStageView } from '../../lib/goalStages'
import type { Goal } from '../../types/goal'

function StageGlyph({ stage, running }: { stage: GoalStage; running: boolean }) {
  const cls = 'h-3 w-3 shrink-0'
  switch (stage.state) {
    case 'done':
      return <Check className={cn(cls, 'text-emerald-500')} />
    case 'active':
      return running
        ? <Loader2 className={cn(cls, 'text-amber-500 animate-spin')} />
        : <Pause className={cn(cls, 'text-amber-500')} />
    case 'failed':
      return <AlertCircle className={cn(cls, 'text-rose-500')} />
    default:
      return <CircleDashed className={cn(cls, 'text-muted-foreground/50')} />
  }
}

function StageChip({ stage, running, isLastActive }: { stage: GoalStage; running: boolean; isLastActive: boolean }) {
  const isActive = stage.state === 'active'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium select-none transition-colors',
        stage.state === 'done' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        isActive && 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-semibold shadow-2xs',
        stage.state === 'failed' && 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
        stage.state === 'pending' && 'border-border/40 text-muted-foreground/60',
      )}
    >
      <StageGlyph stage={stage} running={running} />
      {stage.label}
      {isActive && isLastActive && running && (
        <span className="absolute inset-0 rounded-full ring-1 ring-amber-500/30 animate-pulse" />
      )}
    </span>
  )
}

/**
 * U5 验收佐证 chip：verify 阶段旁的交付语义计数。
 *   · 佐证 ✓N —— deliverable_count：动作结果带屏幕证据命中声明目标；
 *   · 接管 ×N —— handoff_count：结果移交了人处理。
 * 零值不渲染（0 次佐证不是"零分"，是"没有该项记录"——渲染出来就是说谎）；
 * deliveryHints 缺省（旧事件 / 旧后端）什么都不加，与现状一致。
 */
function EvidenceChips({ goal }: { goal: Goal }) {
  const hints = goal.deliveryHints
  if (!hints) return null
  const deliverable = Number.isFinite(hints.deliverableCount) ? hints.deliverableCount : 0
  const handoff = Number.isFinite(hints.handoffCount) ? hints.handoffCount : 0
  if (deliverable <= 0 && handoff <= 0) return null
  return (
    <>
      {deliverable > 0 && (
        <span
          className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium select-none text-emerald-600 dark:text-emerald-400"
          title={`动作结果带屏幕证据命中声明目标 ${deliverable} 次`}
        >
          佐证 ✓{deliverable}
        </span>
      )}
      {handoff > 0 && (
        <span
          className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium select-none text-amber-600 dark:text-amber-400"
          title={`动作结果移交人处理 ${handoff} 次${hints.latestHandoffDetail ? `：${hints.latestHandoffDetail}` : ''}`}
        >
          接管 ×{handoff}
        </span>
      )}
    </>
  )
}

/**
 * 目标卡内的阶段进度条。Row 2（GoalProgress 的比例条）给"子任务完成度"，
 * 这里给"流水线阶段"——两行互补，不重复。
 */
export function GoalPipelineProgress({ goal }: { goal: Goal }) {
  const view: GoalStageView = deriveGoalStages(goal)
  const activeIdx = view.stages.findIndex((s) => s.state === 'active')
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
      {view.stages.map((s, i) => (
        <span key={s.id} className="relative inline-flex items-center gap-1.5">
          <StageChip stage={s} running={view.running} isLastActive={i === activeIdx} />
          {/* 佐证 chip 挂在 verify 阶段旁（验证门恰好是证据的消费者）。 */}
          {s.id === 'verify' && <EvidenceChips goal={goal} />}
          {i < view.stages.length - 1 && (
            <span
              className={cn(
                'h-px w-3',
                s.state === 'done' ? 'bg-emerald-500/40' : 'bg-border/60',
              )}
            />
          )}
        </span>
      ))}
      {view.note && (
        <span className="ml-auto text-[10px] text-muted-foreground/70 font-mono tabular-nums truncate max-w-[220px]" title={view.note}>
          {view.note}
        </span>
      )}
    </div>
  )
}
