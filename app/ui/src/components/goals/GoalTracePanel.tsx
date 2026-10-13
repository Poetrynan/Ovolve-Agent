// src/components/goals/GoalTracePanel.tsx
// 一个目标的事件轨迹（跨会话）。
//
// 为什么不复用 `/api/events/{sessionId}`：一个目标会跨会话——暂停、重启、续跑
// 各开一个新会话，所以按会话读只能回答"这一段时间里发生了什么"，回答不了
// "这个目标到底做了什么"。后端 `GET /api/goals/{id}/events` 按 goal_id 相关列
// 读同一批行。
//
// 刻意不显示"已校验"：哈希链是按会话从各自 genesis 起算的，任何跨会话子集
// 天然缺链，标成已校验就是把一句假话搬到界面上。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Loader2, Activity } from 'lucide-react'
import { API_BASE, fetchJson } from '@lib/api'

interface TraceEvent {
  seq: number
  event_type: string
  session_id: string
  timestamp: number
  run_id?: string | null
  turn_id?: string | null
  tool_call_id?: string | null
  payload?: Record<string, unknown>
}

function summarize(e: TraceEvent): string {
  const p = e.payload || {}
  const tool = typeof p.tool === 'string' ? p.tool : ''
  const status = typeof p.status === 'string' ? p.status : ''
  return [tool, status].filter(Boolean).join(' · ')
}

export function GoalTracePanel({ goalId }: { goalId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<TraceEvent[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (!next || events !== null) return
    setLoading(true)
    setError('')
    try {
      const res = await fetchJson<{ events?: TraceEvent[] }>(
        `${API_BASE}/api/goals/${goalId}/events?limit=200`)
      setEvents(Array.isArray(res?.events) ? res.events : [])
    } catch (e) {
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
        <Activity className="h-3 w-3" />
        {t('goalsPage.traceToggle')}
        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
      </button>

      {open && (
        <div className="mt-2 space-y-1">
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          {!error && events !== null && events.length === 0 && (
            <p className="text-[11px] text-muted-foreground/70">{t('goalsPage.traceEmpty')}</p>
          )}
          {events !== null && events.length > 0 && (
            <p className="text-[10px] text-muted-foreground/60">{t('goalsPage.traceNotVerifiable')}</p>
          )}
          {(events || []).map((e) => (
            <div key={`${e.session_id}:${e.seq}`}
              className="flex items-baseline gap-2 rounded-lg border border-border/30
                bg-background/30 px-2 py-1 text-[10px]">
              <span className="font-mono tabular-nums text-muted-foreground/60">#{e.seq}</span>
              <span className="font-medium">{e.event_type}</span>
              <span className="truncate text-muted-foreground/80">{summarize(e)}</span>
              <span className="ml-auto shrink-0 font-mono text-muted-foreground/50">
                {e.session_id.slice(0, 8)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
