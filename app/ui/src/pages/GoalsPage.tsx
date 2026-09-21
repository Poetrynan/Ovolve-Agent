import { useEffect, useMemo, useState } from 'react'
import { useGoalStore } from '@store/goalStore'
import {
  Plus,
  Play,
  Pause,
  CheckCircle2,
  Target,
  Zap,
  Trash2,
  AlertCircle,
  Loader2,
  RotateCcw,
  X,
  Coins,
} from 'lucide-react'
import { GoalRoundsPanel } from '@components/goals/GoalRoundsPanel'
import { GoalTracePanel } from '@components/goals/GoalTracePanel'
import { AcceptanceGateCard, type AcceptanceContractData } from '@components/goals/AcceptanceGateCard'
import { API_BASE, apiFetch } from '@lib/api'
import { Button } from '@components/ui/button'
import { Card, CardContent } from '@components/ui/card'
import { Badge } from '@components/ui/badge'
import { Progress } from '@components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@components/ui/dialog'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import type { Goal, GoalStatus } from '@apptypes/index'

const RUNNING_STATES = new Set<GoalStatus>(['running', 'queued', 'started', 'active'])

type FilterTab = 'all' | 'active' | 'completed' | 'paused' | 'failed'

function statusLabel(status: GoalStatus, t: (k: string) => string): string {
  switch (status) {
    case 'running': return t('goalsPage.statusRunning')
    case 'queued': return t('goalsPage.statusQueued')
    case 'stopping': return '正在停止...'
    case 'stop_timeout': return '停止超时 (现场已封存)'
    case 'paused': return t('goalsPage.statusPaused')
    case 'completed': return t('goalsPage.statusAchieved')
    case 'failed':
    case 'ovolve_failed_final': return t('goalsPage.statusFailed')
    default: return t('goalsPage.statusIdle')
  }
}

function statusColor(status: GoalStatus): string {
  if (status === 'completed') return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
  if (RUNNING_STATES.has(status)) return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
  if (status === 'stopping' || status === 'stop_timeout') return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
  if (status === 'paused') return 'bg-muted text-muted-foreground border-border/40'
  if (status === 'failed' || status === 'ovolve_failed_final') return 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30'
  return 'bg-muted text-muted-foreground border-border/40'
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function GoalProgress({ goal }: { goal: Goal }) {
  const { t } = useTranslation()
  const total = num(goal.subtasksTotal)
  const ratio = goal.progressRatio

  if (total > 0 && ratio !== null && ratio !== undefined) {
    const pct = Math.round(num(ratio) * 100)
    return (
      <div className="flex items-center gap-3">
        <Progress value={pct} className="h-1.5 flex-1 max-w-md bg-muted/60" />
        <span className="text-xs font-mono font-bold text-foreground/90 shrink-0 tabular-nums">
          {num(goal.subtasksCompleted)}/{total} ({pct}%)
        </span>
      </div>
    )
  }

  const iteration = num(goal.iteration)
  return (
    <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
      <span className="font-mono tabular-nums">
        {goal.maxIterationsKnown
          ? t('goalsPage.iterationOf', { n: iteration, max: num(goal.maxIterations) })
          : t('goalsPage.iterationOnly', { n: iteration })}
      </span>
      <span className="text-[11px] text-muted-foreground/50">
        · {t('goalsPage.noPlanYet', '尚未分解出子阶段')}
      </span>
    </div>
  )
}

function GoalBudget({ goal }: { goal: Goal }) {
  const { t } = useTranslation()
  const spent = num(goal.costUsd)
  const cap = num(goal.costCapUsd)
  if (!(spent > 0)) return null
  const nearCap = cap > 0 && spent / cap >= 0.8
  return (
    <span
      className={cn(
        'text-xs font-mono tabular-nums flex items-center gap-1',
        nearCap ? 'text-amber-500 font-semibold' : 'text-muted-foreground/80',
      )}
      title={t('goalsPage.costTooltip')}
    >
      <Coins size={12} className="shrink-0 opacity-70" />
      ${spent.toFixed(3)}{cap > 0 ? ` / $${cap.toFixed(2)}` : ''}
    </span>
  )
}

const GOAL_TEMPLATES = [
  '重构核心组件并提升前端渲染性能',
  '补充关键业务路径的单元测试用例',
  '进行项目依赖库安全漏洞审计',
  '生成完整的 API 文档与开发架构说明',
]

function GoalAcceptanceGateSection({ goalId }: { goalId: string }) {
  const [contract, setContract] = useState<AcceptanceContractData | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await apiFetch(`${API_BASE}/api/goals/${goalId}/contract`)
        if (res.ok) {
          const data = await res.json()
          if (!cancelled && data.contract) {
            setContract(data.contract)
          }
        }
      } catch {
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [goalId])

  if (!contract && !loading) return null

  return (
    <div className="pt-2">
      <AcceptanceGateCard
        contract={contract || { goal_id: goalId, summary: '机器验收门禁契约' }}
        isVerifying={loading}
      />
    </div>
  )
}

export default function GoalsPage() {
  const { t } = useTranslation()
  const {
    goals, fetchGoals, createGoal, updateGoal, deleteGoal,
    runGoal, pauseGoal, error, clearError, busyIds, loading,
  } = useGoalStore()
  const [newGoal, setNewGoal] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [filter, setFilter] = useState<FilterTab>('all')

  useEffect(() => { void fetchGoals() }, [fetchGoals])

  const handleCreate = (text?: string) => {
    const target = (text ?? newGoal).trim()
    if (!target) return
    void createGoal(target)
    setNewGoal('')
    setCreateOpen(false)
  }

  // Metrics
  const totalGoals = goals.length
  const activeGoals = goals.filter(g => RUNNING_STATES.has(g.status)).length
  const completedGoals = goals.filter(g => g.status === 'completed').length
  const pausedGoals = goals.filter(g => g.status === 'paused').length
  const failedGoals = goals.filter(g => g.status === 'failed' || g.status === 'ovolve_failed_final').length
  const completionRate = totalGoals > 0 ? Math.round((completedGoals / totalGoals) * 100) : 0

  // Filtered goals
  const filteredGoals = useMemo(() => {
    switch (filter) {
      case 'active': return goals.filter(g => RUNNING_STATES.has(g.status))
      case 'completed': return goals.filter(g => g.status === 'completed')
      case 'paused': return goals.filter(g => g.status === 'paused')
      case 'failed': return goals.filter(g => g.status === 'failed' || g.status === 'ovolve_failed_final')
      default: return goals
    }
  }, [goals, filter])

  const filterTabs = [
    { id: 'all' as FilterTab, label: '全部', count: totalGoals },
    { id: 'active' as FilterTab, label: '推进中', count: activeGoals },
    { id: 'completed' as FilterTab, label: '已达成', count: completedGoals },
    { id: 'paused' as FilterTab, label: '已暂停', count: pausedGoals },
    ...(failedGoals > 0 ? [{ id: 'failed' as FilterTab, label: '异常', count: failedGoals }] : []),
  ]

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl space-y-6 animate-fade-in">
      {/* Header & Integrated Action Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-border/40">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-foreground/10 text-foreground border border-border/40 shadow-xs">
              <Target size={22} className="stroke-[2.2]" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-heading font-extrabold tracking-tight text-foreground">
              {t('goalsPage.title')}
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 ml-1">
            {t('goalsPage.subtitle')}
          </p>
        </div>

        {/* Right Header: Ribbon Status + Fast Create Button */}
        <div className="flex items-center gap-3 flex-wrap self-start md:self-auto">
          <div className="flex items-center gap-3 px-3.5 py-2 rounded-xl bg-card/70 border border-border/50 shadow-xs text-xs font-semibold select-none backdrop-blur-md">
            <span className="flex items-center gap-1.5 text-foreground">
              <span className="w-2 h-2 rounded-full bg-foreground/40" />
              <span>总计 {totalGoals}</span>
            </span>
            <span className="h-3 w-px bg-border/60" />
            <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
              <span className={cn('w-2 h-2 rounded-full bg-amber-500', activeGoals > 0 && 'animate-pulse')} />
              <span>推进中 {activeGoals}</span>
            </span>
            <span className="h-3 w-px bg-border/60" />
            <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              <span>已闭环 {completedGoals}</span>
            </span>
            <span className="h-3 w-px bg-border/60" />
            <span className="text-muted-foreground font-mono font-bold">
              {completionRate}%
            </span>
          </div>

          <Button
            onClick={() => setCreateOpen(true)}
            className="rounded-xl px-4 h-9.5 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 shadow-xs shrink-0 select-none gap-1.5"
          >
            <Plus className="h-4 w-4" />
            <span>新建目标</span>
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive shadow-xs">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={clearError} className="p-1 hover:text-foreground">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Filter Tabs Bar (No Giant Input Box Clogging the Page!) */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
        <div className="flex items-center gap-1 bg-muted/40 p-1 rounded-xl border border-border/40 shadow-2xs self-start">
          {filterTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-semibold select-none transition-colors duration-150',
                filter === tab.id
                  ? 'bg-card text-foreground shadow-2xs border border-border/50 font-bold'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-transparent',
              )}
            >
              <span>{tab.label}</span>
              <span className="ml-1.5 text-[10px] font-mono opacity-70">
                {tab.count}
              </span>
            </button>
          ))}
        </div>
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
      </div>

      {/* Goals Pipeline List */}
      <div className="space-y-3">
        {filteredGoals.length === 0 && !loading ? (
          <div className="text-center py-16 px-4 rounded-2xl border border-dashed border-border/60 bg-card/30 space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-foreground/5 flex items-center justify-center mx-auto text-foreground">
              <Target className="w-6 h-6" />
            </div>
            <h4 className="text-sm font-bold text-foreground">
              {filter === 'all' ? t('goalsPage.emptyGoalsTitle') : '当前状态暂无目标'}
            </h4>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              {filter === 'all' ? '点击右上角「新建目标」创建长期多阶段自动化任务' : '切换其他过滤标签或新建目标'}
            </p>
            {filter === 'all' && (
              <Button
                onClick={() => setCreateOpen(true)}
                size="sm"
                className="rounded-xl px-4 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 shadow-xs gap-1.5 mt-2"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新建目标</span>
              </Button>
            )}
          </div>
        ) : (
          filteredGoals.map((goal: Goal) => {
            const isRunning = RUNNING_STATES.has(goal.status)
            const isDone = goal.status === 'completed'
            const isPaused = goal.status === 'paused'
            const isFailed = goal.status === 'failed' || goal.status === 'ovolve_failed_final'
            const busy = busyIds.includes(goal.id)

            return (
              <Card
                key={goal.id}
                className={cn(
                  'rounded-2xl border transition-all duration-200 bg-card/70 backdrop-blur-md overflow-hidden shadow-xs hover:shadow-md',
                  isDone && 'border-emerald-500/30 bg-emerald-500/5',
                  isFailed && 'border-rose-500/30 bg-rose-500/5',
                  isPaused && 'border-amber-500/30 bg-amber-500/5',
                  isRunning && 'border-foreground/30 ring-1 ring-foreground/20',
                  !isDone && !isFailed && !isPaused && !isRunning && 'border-border/50',
                )}
              >
                <CardContent className="p-4 sm:p-5 space-y-3">
                  {/* Row 1: Status badge + Description + Quick Actions */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 flex-1 min-w-0">
                      <Badge
                        className={cn('text-[10px] font-bold rounded-lg px-2.5 py-0.5 border shadow-2xs shrink-0', statusColor(goal.status))}
                      >
                        {isRunning && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
                        {statusLabel(goal.status, t)}
                      </Badge>
                      <h4 className={cn(
                        'text-sm font-bold text-foreground flex-1 min-w-0 leading-snug',
                        isDone && 'line-through text-muted-foreground',
                      )}>
                        {goal.description}
                      </h4>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {!isRunning && !isDone && !isFailed && (
                        <Button
                          size="sm"
                          onClick={() => runGoal(goal.id)}
                          disabled={busy}
                          className="rounded-lg h-7.5 px-3 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 shadow-xs"
                        >
                          {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
                          {t('goalsPage.execute')}
                        </Button>
                      )}

                      {isRunning && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => pauseGoal(goal.id)}
                          disabled={busy}
                          className="rounded-lg h-7.5 px-2.5 text-xs border-amber-500/30 text-amber-600 dark:text-amber-400"
                        >
                          <Pause className="h-3 w-3 mr-1 text-amber-500" />
                          {t('goalsPage.pause')}
                        </Button>
                      )}

                      {isPaused && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runGoal(goal.id)}
                          disabled={busy}
                          className="rounded-lg h-7.5 px-2.5 text-xs border-border/50 text-foreground"
                        >
                          <Play className="h-3 w-3 mr-1" />
                          {t('goalsPage.resume')}
                        </Button>
                      )}

                      {isFailed && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runGoal(goal.id)}
                          disabled={busy}
                          className="rounded-lg h-7.5 px-2.5 text-xs border-amber-500/30 text-amber-600 dark:text-amber-400"
                        >
                          <RotateCcw className="h-3 w-3 mr-1 text-amber-500" />
                          {t('goalsPage.retry')}
                        </Button>
                      )}

                      {!isDone && !isRunning && (
                        <Button
                          size="sm"
                          onClick={() => updateGoal(goal.id, { status: 'completed' } as any)}
                          disabled={busy}
                          className="rounded-lg h-7.5 px-2.5 text-xs font-semibold bg-foreground/10 hover:bg-foreground/20 text-foreground border border-border/40 shadow-2xs"
                        >
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          {t('goalsPage.markComplete')}
                        </Button>
                      )}

                      {isDone && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => updateGoal(goal.id, { status: 'active' } as any)}
                          disabled={busy}
                          className="rounded-lg h-7.5 px-2.5 text-xs"
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          {t('goalsPage.reopen')}
                        </Button>
                      )}

                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => deleteGoal(goal.id)}
                        disabled={busy || isRunning}
                        className="rounded-lg h-7.5 w-7.5 p-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Row 2: Pipeline Progress */}
                  <GoalProgress goal={goal} />

                  {/* Row 3: Metadata & Cost */}
                  <div className="flex items-center justify-between text-xs pt-1 border-t border-border/30">
                    <div className="flex items-center gap-3">
                      <GoalBudget goal={goal} />
                      {goal.lastError && (
                        <span className="text-[10px] text-destructive truncate max-w-[280px]" title={goal.lastError}>
                          {goal.lastError}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground/60 font-mono">
                      ID: {goal.id.slice(0, 8)}
                    </span>
                  </div>

                  {/* Row 3.5: 机器验收门禁契约 (Anti-Early-Quit) */}
                  <GoalAcceptanceGateSection goalId={goal.id} />

                  {/* Row 4: 逐轮轨迹。按需拉取，展开才请求。 */}
                  <GoalRoundsPanel goalId={goal.id} />

                  {/* Row 5: 事件轨迹。逐轮给的是"每轮的裁决"，这里是"每一步的事实"，
                      而且跨会话——续跑开的新会话也归到同一个目标名下。 */}
                  <GoalTracePanel goalId={goal.id} />
                </CardContent>
              </Card>
            )
          })
        )}
      </div>

      {/* Creation Modal Dialog — Zero Screen Real Estate Wasted! */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg rounded-2xl border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl p-6 space-y-4">
          <DialogHeader className="space-y-1">
            <div className="flex items-center gap-2">
              <Target className="w-5 h-5 text-foreground" />
              <DialogTitle className="text-base font-bold text-foreground">
                设定新的自动化目标
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs text-muted-foreground">
              编排长期多阶段任务，由 6 大 Agent 智能体协同推进执行。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            <textarea
              autoFocus
              value={newGoal}
              onChange={e => setNewGoal(e.target.value)}
              placeholder="例如：重构前端组件样式并提升 Lighthouse 性能评分至 95+..."
              rows={3}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                  e.preventDefault()
                  handleCreate()
                }
              }}
              className="w-full resize-none rounded-xl bg-background/80 border border-border/60 p-3 text-xs sm:text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-2 focus:ring-foreground/20 focus:border-foreground/40 transition-all font-medium leading-relaxed"
            />

            {/* Quick Templates inside Dialog */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-muted-foreground/70">快速灵感模板:</span>
              <div className="flex flex-wrap gap-1.5">
                {GOAL_TEMPLATES.map((tmpl, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setNewGoal(tmpl)}
                    className="text-[11px] px-2.5 py-1 rounded-lg bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/40 transition-colors select-none text-left"
                  >
                    {tmpl}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2 border-t border-border/30">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateOpen(false)}
              className="rounded-xl h-9 px-4 text-xs"
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => handleCreate()}
              disabled={!newGoal.trim()}
              className="rounded-xl h-9 px-5 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 shadow-xs"
            >
              派发目标
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
