// src/components/goals/GoalHandoffBanner.tsx
// 目标需要人接管的琥珀色警示条（U5）。数据源：goal_state_change WS 事件里的
// handoff_required=true + handoff_detail（goalStore.applyStateChange 落到
// goal.handoffRequired / goal.handoffDetail）。
//
// 纪律：
//   · handoffRequired 严格 !== true 一律返回 null——没有信号就绝不做提示，
//     不渲染空壳、不渲染"曾经需要接管"的残留（store 侧已按事件覆写清除）。
//   · role="alert"：状态翻转即被读屏播报，接管是必须被打断的场景。
//   · 跳转按钮对齐项目既有导航手法（GoalsPage 的 onBackToChat 回调 prop），
//     不新造路由机制。
import { Hand } from 'lucide-react'
import type { Goal } from '../../types/goal'

interface GoalHandoffBannerProps {
  goal: Goal
  /** 跳转回调（对齐 GoalsPage 的 onBackToChat 导航手法）。 */
  onJump?: () => void
}

export function GoalHandoffBanner({ goal, onJump }: GoalHandoffBannerProps) {
  if (goal.handoffRequired !== true) return null
  const detail = typeof goal.handoffDetail === 'string' ? goal.handoffDetail.trim() : ''
  return (
    <div
      role="alert"
      className="flex items-center gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 dark:bg-amber-500/5 px-3 py-2 text-xs shadow-2xs animate-in fade-in slide-in-from-bottom-2 duration-200"
    >
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-500">
        <Hand size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-amber-600 dark:text-amber-400">需要你接管</div>
        {detail && (
          <div
            className="truncate max-w-md text-[11px] text-muted-foreground"
            title={detail}
          >
            {detail}
          </div>
        )}
      </div>
      {onJump && (
        <button
          type="button"
          onClick={onJump}
          className="shrink-0 rounded-lg border border-amber-500/40 px-2.5 py-1 text-[11px] font-semibold text-amber-600 transition-colors hover:bg-amber-500/10 cursor-pointer dark:text-amber-400"
        >
          去会话处理
        </button>
      )}
    </div>
  )
}

export default GoalHandoffBanner
