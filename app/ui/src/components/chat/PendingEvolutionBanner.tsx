// src/components/chat/PendingEvolutionBanner.tsx
// 聊天界面里"有东西在等你确认"的常驻提示。
//
// 为什么不能只靠 EvolutionNotice 那枚 chip：chip 是一条**实时事件**落成的时间线
// 行，只活在内存里。刷新窗口、切走再切回来、或者第二天打开，历史是从数据库重建
// 的，那一行不在里面——于是待审的记忆提案和技能草稿在聊天界面彻底消失，只剩侧栏
// 一个数字。这条 strip 读的是 §15 审批投影（30s 轮询，后端为真相），所以"有需要
// 演化的就会显示出来"这件事不再依赖用户恰好在那一秒看着屏幕。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ShieldAlert, ArrowRight, X } from 'lucide-react'
import { useApprovalsStore } from '@store/approvalsStore'
import { Button } from '@components/ui/button'
import { cn } from '@lib/utils'

export function PendingEvolutionBanner({ className }: { className?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const counts = useApprovalsStore((s) => s.data.counts)
  // 关掉的是"这个数字"而不是这个功能：又有新东西进来（总数变大）时重新出现，
  // 否则一次误点就永久静音了整条闭环的提醒。
  const [mutedAt, setMutedAt] = useState(0)

  const total = counts.total
  if (total <= 0 || total <= mutedAt) return null

  const hasMemories = counts.evolutionProposals > 0
  const hasSkills = counts.skillCandidates > 0

  let description = ''
  if (hasMemories && !hasSkills) {
    description = t('pendingEvolution.singleMemory', { count: counts.evolutionProposals })
  } else if (!hasMemories && hasSkills) {
    description = t('pendingEvolution.singleSkill', { count: counts.skillCandidates })
  } else {
    const details = [
      t('pendingEvolution.memoriesCount', { count: counts.evolutionProposals }),
      t('pendingEvolution.skillsCount', { count: counts.skillCandidates }),
    ].join('、')
    description = t('pendingEvolution.mixed', { count: total, details })
  }

  return (
    <div
      role="status"
      className={cn(
        'mx-4 mt-3 flex items-center gap-3 rounded-2xl border px-4 py-2 text-xs shadow-sm backdrop-blur-2xl transition-all duration-200',
        'border-amber-400/40 bg-amber-500/10 dark:bg-amber-500/10 dark:border-amber-400/25 text-foreground ring-1 ring-amber-400/15',
        className,
      )}
    >
      <span className="flex items-center gap-1.5 shrink-0 px-2.5 py-0.5 rounded-lg bg-amber-500/20 text-amber-900 dark:text-amber-200 font-semibold text-[11px] border border-amber-500/30 shadow-2xs">
        <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        {t('pendingEvolution.badge')}
      </span>
      <span className="min-w-0 truncate text-amber-950/90 dark:text-amber-100 font-medium">
        {description}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="ml-auto h-6.5 shrink-0 gap-1.5 rounded-xl px-3 text-[11.5px] bg-card/80 hover:bg-card text-foreground border border-amber-400/40 hover:border-amber-400/70 font-medium shadow-xs backdrop-blur-md transition-all press-feedback"
        onClick={() => navigate('/approvals')}
      >
        {t('pendingEvolution.go')}
        <ArrowRight className="h-3 w-3 text-amber-600 dark:text-amber-400" />
      </Button>
      <button
        type="button"
        aria-label={t('pendingEvolution.dismiss')}
        title={t('pendingEvolution.dismiss')}
        className="shrink-0 rounded-lg p-1 text-amber-700/70 hover:text-amber-950 dark:text-amber-400/70 dark:hover:text-amber-200 hover:bg-amber-500/10 transition-colors"
        onClick={() => setMutedAt(total)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
