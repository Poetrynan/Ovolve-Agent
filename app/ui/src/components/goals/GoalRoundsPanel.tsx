// src/components/goals/GoalRoundsPanel.tsx
// 一个目标的逐轮轨迹（ordinal / 裁决 / 理由 / 证据摘要 / 花费）。
//
// 为什么需要它：目标卡上只有一个计数器"3/10 轮"，回答不了"第 3 轮做了什么、
// 验证为什么否掉它"——而这正是一个自动跑了十轮的目标唯一值得看的东西。后端
// `GET /api/goals/{id}/iterations` 一直存在，但在这个组件之前**没有任何前端
// 消费它**，逐轮证据写进了库却没人能看见。
//
// 按需拉取：目标列表可能很长，展开哪一个就只拉那一个。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Loader2, ListOrdered } from 'lucide-react'
import { API_BASE, fetchJson } from '@lib/api'
import { cn } from '@lib/utils'

export interface GoalRound {
  ordinal: number
  startedAt?: number
  endedAt?: number
  verdict?: string
  reason?: string
  evidence?: string
  costMicros?: number
  tokens?: number
}

function verdictTone(verdict?: string): string {
  const v = (verdict || '').toLowerCase()
  if (v.includes('pass') || v === 'completed' || v === 'accepted') {
    return 'text-emerald-600 dark:text-emerald-400'
  }
  if (v.includes('reject') || v.includes('fail')) return 'text-destructive'
  return 'text-muted-foreground'
}

export function GoalRoundsPanel({ goalId }: { goalId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [rounds, setRounds] = useState<GoalRound[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (!next || rounds !== null) return
    setLoading(true)
    setError('')
    try {
      const res = await fetchJson<{ iterations?: GoalRound[] }>(
        `${API_BASE}/api/goals/${goalId}/iterations`)
      setRounds(Array.isArray(res?.iterations) ? res.iterations : [])
    } catch (e) {
      // 拉不到就说拉不到。空列表和"请求失败"是两件事，混在一起会让用户以为
      // 这个目标一轮都没跑过。
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={() => void toggle()}
        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground
          hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <ListOrdered className="h-3 w-3" />
        {t('goalsPage.roundsToggle')}
        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5">
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          {!error && rounds !== null && rounds.length === 0 && (
            <p className="text-[11px] text-muted-foreground/70">{t('goalsPage.roundsEmpty')}</p>
          )}
          {(rounds || []).map((r) => (
            <div key={r.ordinal}
              className="rounded-xl border border-border/40 bg-background/40 p-2.5 space-y-1">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-mono font-semibold tabular-nums">#{r.ordinal}</span>
                <span className={cn('font-medium', verdictTone(r.verdict))}>
                  {r.verdict || t('goalsPage.roundNoVerdict')}
                </span>
                {typeof r.costMicros === 'number' && r.costMicros > 0 && (
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
                    ${(r.costMicros / 1_000_000).toFixed(4)}
                  </span>
                )}
              </div>
              {r.reason ? (
                <p className="text-[11px] leading-relaxed text-muted-foreground">{r.reason}</p>
              ) : null}
              {r.evidence ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-[10px]
                  leading-relaxed text-muted-foreground/80">{r.evidence}</pre>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
