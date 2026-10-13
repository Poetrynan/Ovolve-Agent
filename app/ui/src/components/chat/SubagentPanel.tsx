/**
 * SubagentPanel — live progress card for the parallel `task` tool.
 *
 * When the parent turn spawns N sub-agents, the model's next message can only
 * arrive after ALL of them finish. Without this panel the user sees a single
 * unmoving spinner for the whole batch; with it, each sub-agent has its own
 * row that turns from spawning → running → completed as the state machine on
 * the backend advances.
 *
 * Reads `subagents` from `useAgentStore` — that array is a direct projection
 * of `SubagentSession` on the backend, so the six-state machine is authored
 * in one place and mirrored here without re-derivation.
 *
 * Kill button hits `POST /api/subagents/:id/kill`. The status flip is NOT
 * optimistic: the backend is the single writer for terminal state, and the
 * next `subagent_state` frame will flip it for us. That way a killed row can
 * never disagree with the runtime.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock, Loader2, StopCircle, XCircle } from 'lucide-react'
import { API_BASE, apiFetch } from '@lib/api'
import { cn } from '@lib/utils'
import { useAgentStore } from '@store/agentStore'
import { SubagentActivityView } from './SubagentActivityView'
import { BorderBeam } from '@/components/ui/BorderBeam'
import type { SubagentInfo, SubagentStatus } from '@apptypes/index'

const TERMINAL: SubagentStatus[] = [
  'completed', 'error', 'killed', 'timeout', 'stale', 'spawn_error', 'lost',
]

function StatusIcon({ status }: { status: SubagentStatus }) {
  const cls = 'h-3.5 w-3.5 shrink-0'
  switch (status) {
    case 'spawning':
      // Distinct from running: this one's still queued on the semaphore.
      return <Clock className={cn(cls, 'text-muted-foreground')} />
    case 'running':
      return <Loader2 className={cn(cls, 'text-foreground animate-spin')} />
    case 'completed':
      return <CheckCircle2 className={cn(cls, 'text-success')} />
    case 'error':
      return <XCircle className={cn(cls, 'text-destructive')} />
    case 'killed':
      return <StopCircle className={cn(cls, 'text-warning')} />
    case 'timeout':
      // A timeout is an error the runtime imposed rather than one the sub-agent
      // reported — an amber X so it reads distinctly from a genuine crash.
      return <XCircle className={cn(cls, 'text-warning')} />
    case 'stale':
      return <AlertTriangle className={cn(cls, 'text-warning')} />
    case 'spawn_error':
      return <XCircle className={cn(cls, 'text-destructive')} />
    case 'lost':
      return <AlertTriangle className={cn(cls, 'text-destructive')} />
    default:
      return <Circle className={cn(cls, 'text-muted-foreground')} />
  }
}

function formatElapsed(ms: number): string {
  if (!ms || ms < 0) return ''
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.floor(s - m * 60)}s`
}

/** 共享给 SubagentTabPanel：右侧栏子代理列表的停止按钮也走这个 API。 */
export async function killSubagent(subagentId: string): Promise<void> {
  try {
    const res = await apiFetch(`${API_BASE}/api/subagents/${encodeURIComponent(subagentId)}/kill`, {
      method: 'POST',
    })
    // 404 just means it already finished — the state machine will show that.
    if (!res.ok && res.status !== 404) {
      console.warn('kill subagent failed:', res.status, await res.text().catch(() => ''))
    }
  } catch (e) {
    console.warn('kill subagent error:', e)
  }
}

/**
 * Kill every live sub-agent of one parent session.
 *
 * Scoped to `sessionId` on purpose — the backend refuses a process-wide kill so
 * one window can never abort another window's fan-out. We read the session from
 * the rows themselves rather than the store's `sessionId`, because the rows are
 * the authority on which parent actually owns this batch.
 */
async function killAllSubagents(sessionId: string): Promise<void> {
  try {
    const res = await apiFetch(`${API_BASE}/api/subagents/kill-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    })
    if (!res.ok) {
      console.warn('kill-all failed:', res.status, await res.text().catch(() => ''))
    }
  } catch (e) {
    console.warn('kill-all error:', e)
  }
}

interface RowProps {
  info: SubagentInfo
  killing: boolean
  onKill: (id: string) => void
  expanded: boolean
  onToggle: (id: string) => void
  /** Chat 流 chip 聚焦的那一行——视觉上标出来，点击处与落点互相可见。 */
  selected?: boolean
}

function SubagentRow({ info, killing, onKill, expanded, onToggle, selected }: RowProps) {
  const { t } = useTranslation()
  const terminal = TERMINAL.includes(info.status)
  const label = info.label || info.subagentType
  const statusLabel = t(`subagentPanel.status.${info.status}`)
  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-2.5 py-1.5 px-2 rounded hover:bg-muted/40 cursor-pointer transition-colors',
          selected && 'bg-primary/10 ring-1 ring-primary/30',
        )}
        onClick={() => onToggle(info.subagentId)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggle(info.subagentId) }}
        aria-expanded={expanded}
        aria-label={t('subagentPanel.toggleAria', { label })}
      >
        <span className="shrink-0 text-muted-foreground">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
        <StatusIcon status={info.status} />
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground shrink-0 w-16">
          {info.subagentType}
        </span>
        <span className="text-xs text-foreground truncate flex-1 min-w-0">
          {label}
        </span>
        <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
          {formatElapsed(info.elapsedMs)}
        </span>
        <span
          className={cn(
            'text-[11px] shrink-0 min-w-[54px] text-right',
            info.status === 'error' || info.status === 'timeout' || info.status === 'lost'
              ? 'text-destructive'
              : info.status === 'killed' || info.status === 'spawn_error'
                ? 'text-warning'
                : info.status === 'completed'
                  ? 'text-success'
                  : 'text-muted-foreground',
          )}
        >
          {statusLabel}
        </span>
        {!terminal && (
          <button
            type="button"
            disabled={killing}
            onClick={(e) => { e.stopPropagation(); onKill(info.subagentId) }}
            className={cn(
              'text-[11px] px-1.5 py-0.5 rounded shrink-0',
              'text-muted-foreground hover:text-destructive hover:bg-destructive/10',
              'disabled:opacity-50 disabled:cursor-not-allowed transition-colors',
            )}
            aria-label={t('subagentPanel.killAria', { label })}
          >
            {killing ? t('subagentPanel.killing') : t('subagentPanel.kill')}
          </button>
        )}
      </div>
      {expanded && (
        <div className="ml-6 border-l border-border/40 overflow-y-auto max-h-64">
          {info.execMode === 'subprocess' && (info.pid || info.logPath) ? (
            <div className="px-2 py-1.5 text-[10px] text-muted-foreground font-mono space-y-0.5 border-b border-border/30">
              {info.pid ? (
                <div className="truncate" title={String(info.pid)}>
                  {t('subagentPanel.subprocessPid', { pid: info.pid })}
                </div>
              ) : null}
              {info.logPath ? (
                <div className="truncate" title={info.logPath}>
                  {t('subagentPanel.subprocessLog', { path: info.logPath })}
                </div>
              ) : null}
            </div>
          ) : null}
          <SubagentActivityView subagentId={info.subagentId} />
        </div>
      )}
    </div>
  )
}

export function SubagentPanel() {
  const { t } = useTranslation()
  const subagents = useAgentStore((s) => s.subagents)
  // Chat 流里点击子代理 chip 会写 selectedSubagentId——这里订阅它并展开
  // 对应行，完成"流内入口 → 侧栏完整流程"的聚焦闭环。用户手动折叠不受
  // 影响：只做展开单向动作，同一 chip 再点一次只是清除选中态。
  const selectedSubagentId = useAgentStore((s) => s.selectedSubagentId)
  const [killing, setKilling] = useState<Record<string, boolean>>({})
  const [killingAll, setKillingAll] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // 单个父会话的子代上限（后端 config 可调）。挂载时拉一次即可——
  // 上限是分钟级的慢变量，不值得为它订阅任何实时通道。
  const [childLimit, setChildLimit] = useState<number | null>(null)

  useEffect(() => {
    if (selectedSubagentId) {
      setExpanded((e) => ({ ...e, [selectedSubagentId]: true }))
    }
  }, [selectedSubagentId])

  useEffect(() => {
    apiFetch(`${API_BASE}/api/subagents`)
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.maxChildrenPerAgent === 'number') setChildLimit(d.maxChildrenPerAgent)
      })
      .catch(() => {})
  }, [])

  if (subagents.length === 0) return null

  const active = subagents.filter((s) => !TERMINAL.includes(s.status)).length
  const done = subagents.length - active
  const nearLimit = childLimit !== null && active >= childLimit
  // Every row in a batch shares one parent, so the first row is authoritative.
  const parentSessionId = subagents[0]?.parentSessionId || ''

  const handleToggle = (id: string) => {
    setExpanded((e) => ({ ...e, [id]: !e[id] }))
  }

  const handleKill = (id: string) => {
    setKilling((k) => ({ ...k, [id]: true }))
    void killSubagent(id).finally(() => {
      // Leave the flag on so the button stays disabled — the state stream will
      // remove the button entirely once the sub-agent reaches a terminal state.
      // Reset only if it clearly failed to kill (still non-terminal after 3s).
      setTimeout(() => setKilling((k) => {
        const next = { ...k }
        delete next[id]
        return next
      }), 3000)
    })
  }

  const handleKillAll = () => {
    if (!parentSessionId) return
    setKillingAll(true)
    // Mark every live row as killing so the per-row buttons go quiet too —
    // otherwise the user sees "stop all" spinning while individual buttons
    // still look actionable.
    setKilling((k) => {
      const next = { ...k }
      for (const s of subagents) {
        if (!TERMINAL.includes(s.status)) next[s.subagentId] = true
      }
      return next
    })
    void killAllSubagents(parentSessionId).finally(() => {
      setTimeout(() => {
        setKillingAll(false)
        setKilling({})
      }, 3000)
    })
  }

  return (
    <div className="relative border border-border/70 rounded-2xl bg-card/65 dark:bg-card/40 backdrop-blur-2xl my-2.5 overflow-hidden shadow-xs ring-1 ring-white/30 dark:ring-white/5">
      {active > 0 && <BorderBeam size={220} duration={3.5} colorFrom="#ec4899" colorTo="#8b5cf6" />}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40">
        <Loader2
          className={cn(
            'h-3.5 w-3.5',
            active > 0 ? 'text-foreground animate-spin' : 'text-muted-foreground',
          )}
        />
        <span className="text-xs font-medium">
          {t('subagentPanel.title')}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {t('subagentPanel.summary', { active, done, total: subagents.length })}
        </span>
        {/* 并行上限（后端可调）。贴近上限时变琥珀色提醒，真到顶时新派单会被拒。 */}
        {childLimit !== null && (
          <span
            className={cn(
              'text-[11px] tabular-nums',
              nearLimit ? 'text-amber-500 font-medium' : 'text-muted-foreground/60',
            )}
            title={t('subagentPanel.limitHint',
              '单个任务最多同时派这么多子任务；到顶后需要等一个完成或手动停止')}
          >
            · {t('subagentPanel.limit', '并行上限 {{n}}', { n: childLimit })}
          </span>
        )}
        {/* Only meaningful while more than one is live — stopping a batch of one
            is what the row's own button is for. */}
        {active > 1 && (
          <button
            type="button"
            disabled={killingAll}
            onClick={handleKillAll}
            className={cn(
              'ml-auto shrink-0 inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded',
              'text-muted-foreground hover:text-destructive hover:bg-destructive/10',
              'disabled:opacity-50 disabled:cursor-not-allowed transition-colors',
            )}
            aria-label={t('subagentPanel.killAllAria', { count: active })}
          >
            <StopCircle className="h-3 w-3" />
            {killingAll
              ? t('subagentPanel.killing')
              : t('subagentPanel.killAll', { count: active })}
          </button>
        )}
      </div>
      <div className="p-1">
        {subagents.map((s) => (
          <SubagentRow
            key={s.subagentId}
            info={s}
            killing={!!killing[s.subagentId]}
            onKill={handleKill}
            expanded={!!expanded[s.subagentId]}
            onToggle={handleToggle}
            selected={selectedSubagentId === s.subagentId}
          />
        ))}
      </div>
    </div>
  )
}
