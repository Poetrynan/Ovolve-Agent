// src/components/settings/DreamLogPanel.tsx
// Read-only view of background dream consolidation summaries (MemoryType.DREAM).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Moon, RefreshCw, ChevronDown } from 'lucide-react'
import { Button } from '@components/ui/button'
import { API_BASE, apiFetch } from '@lib/api'
import { cn } from '@lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@components/ui/collapsible'

interface DreamEntry {
  id: string
  content: string
  createdAt: number
  updatedAt: number
}

/** 一趟整合的账本行（§10.2 DreamJournal）。失败和 NO_OP 也在里面——只列成功的
 *  日记会让"它到底有没有在工作"变不可回答，而那正是用户最想知道的事。 */
interface DreamRun {
  jobId: string
  status: string
  /** 状态还是 running 但租约过期了 = 那趟的进程死了。 */
  stale: boolean
  outcome: string
  proposalId: string
  startedAt: number
  finishedAt: number
  inputCount: number
  wallMs: number
}

function runTone(r: DreamRun): string {
  if (r.stale) return 'text-amber-600 dark:text-amber-400'
  if (r.status === 'failed') return 'text-destructive'
  if (r.status === 'done') return 'text-emerald-600 dark:text-emerald-400'
  return 'text-muted-foreground'
}

function fmtTime(ts: number, locale: string): string {
  if (!ts) return '—'
  try {
    return new Date(ts * 1000).toLocaleString(locale)
  } catch {
    return '—'
  }
}

export function DreamLogPanel({ root }: { root: string | null }) {
  const { t, i18n } = useTranslation()
  const [entries, setEntries] = useState<DreamEntry[]>([])
  const [runs, setRuns] = useState<DreamRun[]>([])
  const [lastDreamAt, setLastDreamAt] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async (scope: string | null) => {
    if (scope === null) return
    setLoading(true)
    setError(null)
    try {
      const url = `${API_BASE}/api/memory/entries?type=dream&limit=30&root=${encodeURIComponent(scope)}`
      const r = await apiFetch(url)
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      setEntries(d.entries || [])
      setLastDreamAt(Number(d.lastDreamAt) || 0)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setEntries([])
    } finally {
      setLoading(false)
    }
    // 日记单独取，且它的失败不该把条目列表也变成错误态：两者回答的是不同问题
    // （"整理出了什么" vs "它有没有在跑"），一个坏了不代表另一个没有话说。
    try {
      const r2 = await apiFetch(
        `${API_BASE}/api/memory/dream-runs?limit=20&root=${encodeURIComponent(scope)}`)
      const d2 = await r2.json()
      if (r2.ok) setRuns(d2.runs || [])
    } catch {
      setRuns([])
    }
  }, [])

  useEffect(() => {
    void refresh(root)
  }, [refresh, root])

  const summary = useMemo(() => {
    if (error) return t('dreamLog.error')
    // 有日记就说日记里最近那一句：它比"系统空闲后会自动生成"具体得多，而且在
    // 整理跑过但什么都没产出（NO_OP / 失败）的时候，那句话才是用户要看的答案。
    if (runs.length > 0 && runs[0].outcome) return runs[0].outcome
    if (entries.length === 0) return t('dreamLog.emptyShort')
    if (lastDreamAt > 0) return t('dreamLog.lastRunShort', { time: fmtTime(lastDreamAt, i18n.language) })
    return t('dreamLog.count', { count: entries.length })
  }, [entries.length, error, i18n.language, lastDreamAt, runs, t])

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-2xl border border-border/50 bg-card/55 overflow-hidden">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/40 bg-muted/50 text-muted-foreground">
              <Moon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{t('dreamLog.title')}</span>
                {entries.length > 0 && (
                  <span className="rounded-full border border-border/40 bg-background/70 px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                    {t('dreamLog.count', { count: entries.length })}
                  </span>
                )}
              </div>
              <p className="truncate text-[11px] text-muted-foreground">{summary}</p>
            </div>
            <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')} />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t border-border/40 px-4 pb-4 pt-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <p className="max-w-xl text-xs leading-relaxed text-muted-foreground/85">
                {t('dreamLog.desc')}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 shrink-0 rounded-xl p-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                onClick={() => void refresh(root)}
                aria-label={t('common.refresh')}
              >
                <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
              </Button>
            </div>
            {error && (
              <p className="mb-3 text-xs text-destructive">{error}</p>
            )}
            {entries.length === 0 && !loading && !error && (
              <div className="py-5 text-center text-xs text-muted-foreground">
                {t('dreamLog.empty')}
              </div>
            )}
            {runs.length > 0 && (
              <div className="mb-3 rounded-xl border border-border/40 bg-background/40 p-2.5 space-y-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('dreamLog.journalTitle')}
                </div>
                {runs.map((r) => (
                  <div key={r.jobId} className="flex items-start gap-2 text-[11px]">
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                      {fmtTime(r.startedAt, i18n.language)}
                    </span>
                    <span className={cn('shrink-0 font-medium', runTone(r))}>
                      {r.stale
                        ? t('dreamLog.runStale')
                        : t(`dreamLog.run.${r.status}`, r.status)}
                    </span>
                    <span className="min-w-0 flex-1 text-muted-foreground/85">
                      {r.outcome || '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {entries.length > 0 && (
              <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                {entries.map((e) => (
                  <div
                    key={e.id}
                    className="rounded-xl border border-border/40 bg-background/50 p-3 text-xs shadow-2xs space-y-1.5"
                  >
                    <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap">{e.content}</p>
                    <p className="text-[10px] text-muted-foreground/70 font-mono">
                      {fmtTime(e.updatedAt || e.createdAt, i18n.language)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
