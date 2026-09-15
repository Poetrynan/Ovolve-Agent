// HooksSettings — manage the lifecycle hooks that extend agent behaviour.
//
// The backend hook runner (hook_runner.py) already exists and is protocol-complete
// (9 lifecycle events, command + process hooks, matchers, permission decisions,
// additionalContext injection). What was missing was exactly THIS surface: a place
// in Settings to see what is registered, whether it is enabled, the config files it
// reads, recent execution records, and validation problems — without hand-editing
// JSON in a terminal.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Pause, RefreshCw, Check, X, AlertTriangle, Clock, Terminal,
  FileText, Filter,
} from 'lucide-react'
import { Button } from '@components/ui/button'
import { API_BASE, apiFetch } from '@lib/api'
import { cn } from '@/lib/utils'

interface HookEntry {
  type: string
  command: string
  args: string[]
  timeoutMs: number
}
interface RegisteredHook {
  event: string
  matcher: string | null
  source: string
  hooks: HookEntry[]
}
interface HookRun {
  event: string
  matchValue: string
  command: string
  type: string
  source: string
  status: string
  durationMs: number
  error: string
  ts: number
}
interface HooksState {
  enabled: boolean
  supportedEvents: string[]
  configPaths: string[]
  registered: RegisteredHook[]
  problems: string[]
  recentRuns: HookRun[]
}

const STATUS_STYLE: Record<string, string> = {
  pass: 'bg-success/10 text-success',
  block: 'bg-warning/10 text-warning',
  error: 'bg-destructive/10 text-destructive',
  timeout: 'bg-destructive/10 text-destructive',
  invalid: 'bg-muted text-muted-foreground',
}

function relTime(ts: number): string {
  const s = Math.round((Date.now() / 1000 - ts))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function HooksSettings() {
  const { t } = useTranslation()
  const [state, setState] = useState<HooksState | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch(`${API_BASE}/api/hooks`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setState(await r.json())
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const reload = useCallback(async () => {
    setReloading(true); setError(null)
    try {
      await apiFetch(`${API_BASE}/api/hooks/reload`, { method: 'POST' })
      await load()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setReloading(false)
    }
  }, [load])

  const registered = state?.registered ?? []
  const byEvent = filter === 'all'
    ? registered
    : registered.filter((h) => h.event === filter)
  const eventFilters = Array.from(new Set(registered.map((h) => h.event))).sort()

  return (
    <div className="space-y-5">
      {/* Header card: enable state + actions */}
      <div className="rounded-xl border border-border/40 bg-card/60 p-4 flex items-center gap-4">
        <div className={cn(
          'w-10 h-10 rounded-xl flex items-center justify-center border',
          state?.enabled ? 'bg-success/15 border-success/30 text-success' : 'bg-muted border-border/40 text-muted-foreground',
        )}>
          <Terminal size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {t('settingsPage.hooks.enabledLabel', 'Hooks')}
            </span>
            <span className={cn(
              'text-[10px] font-semibold px-1.5 py-0.5 rounded',
              state?.enabled ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
            )}>
              {state?.enabled
                ? <><Check size={10} className="inline -mt-px" /> {t('settingsPage.hooks.on', 'On')}</>
                : <><Pause size={10} className="inline -mt-px" /> {t('settingsPage.hooks.off', 'Off')}</>}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
            {state?.configPaths?.length
              ? state.configPaths.join('  ·  ')
              : t('settingsPage.hooks.noConfig', 'No hooks.json found — add one to register hooks.')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reload} disabled={reloading || loading} className="rounded-lg h-8 text-xs shrink-0">
          <RefreshCw size={13} className={cn('mr-1.5', reloading && 'animate-spin')} />
          {t('settingsPage.hooks.reload', 'Reload')}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Problems / validation */}
      {state?.problems && state.problems.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-warning">
            <AlertTriangle size={13} />
            {t('settingsPage.hooks.problemsTitle', 'Configuration problems')}
          </div>
          {state.problems.map((p, i) => (
            <p key={i} className="text-[11px] text-muted-foreground leading-relaxed pl-5">{p}</p>
          ))}
        </div>
      )}

      {/* Registered hooks */}
      <div className="rounded-xl border border-border/40 bg-card/60">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30">
          <Filter size={13} className="text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">
            {t('settingsPage.hooks.registeredTitle', 'Registered hooks')} ({registered.length})
          </span>
          {eventFilters.length > 1 && (
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => setFilter('all')}
                className={cn(
                  'text-[10px] px-2 py-0.5 rounded transition-colors',
                  filter === 'all' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t('settingsPage.hooks.all', 'All')}
              </button>
              {eventFilters.map((e) => (
                <button
                  key={e}
                  onClick={() => setFilter(e)}
                  className={cn(
                    'text-[10px] px-2 py-0.5 rounded transition-colors',
                    filter === e ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>

        {registered.length === 0 ? (
          <div className="px-4 py-8 text-center space-y-2">
            <Terminal size={22} className="mx-auto text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">
              {loading
                ? t('common.loading', 'Loading…')
                : t('settingsPage.hooks.empty', 'No hooks registered. Add a hooks.json to extend agent behaviour.')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {byEvent.map((group, i) => (
              <div key={`${group.event}-${group.matcher}-${i}`} className="px-4 py-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent text-foreground font-mono">
                    {group.event}
                  </span>
                  {group.matcher && (
                    <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px]">
                      match: /{group.matcher}/
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground/60 font-mono ml-auto truncate max-w-[160px]" title={group.source}>
                    {group.source ? group.source.split('/').pop() : 'builtin'}
                  </span>
                </div>
                <div className="mt-2 space-y-1">
                  {group.hooks.map((h, j) => (
                    <div key={j} className="flex items-center gap-2 text-[11px]">
                      <Terminal size={11} className="text-muted-foreground shrink-0" />
                      <code className="font-mono text-foreground/80 truncate">{h.command}{(h.args || []).join(' ')}</code>
                      <span className="text-muted-foreground/50 ml-auto shrink-0">{h.timeoutMs}ms</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent execution log */}
      <div className="rounded-xl border border-border/40 bg-card/60">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30">
          <Clock size={13} className="text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">
            {t('settingsPage.hooks.recentTitle', 'Recent runs')} ({(state?.recentRuns ?? []).length})
          </span>
        </div>
        {(state?.recentRuns ?? []).length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {t('settingsPage.hooks.noRuns', 'No hook executions recorded yet.')}
          </div>
        ) : (
          <div className="divide-y divide-border/30 max-h-72 overflow-y-auto">
            {[...(state?.recentRuns ?? [])].reverse().map((run, i) => (
              <div key={`${run.ts}-${i}`} className="px-4 py-2 flex items-center gap-2 text-[11px]">
                <span className={cn('text-[9px] font-bold px-1 py-0.5 rounded shrink-0', STATUS_STYLE[run.status] || 'bg-muted text-muted-foreground')}>
                  {run.status}
                </span>
                <span className="font-mono text-foreground/80 w-28 shrink-0">{run.event}</span>
                <span className="text-muted-foreground truncate flex-1 font-mono">{run.command}</span>
                {run.matchValue && (
                  <span className="text-muted-foreground/60 truncate max-w-[120px] font-mono" title={run.matchValue}>
                    {run.matchValue}
                  </span>
                )}
                {run.error && <X size={11} className="text-destructive shrink-0" />}
                <span className="text-muted-foreground/50 shrink-0 w-12 text-right">{run.durationMs}ms</span>
                <span className="text-muted-foreground/40 shrink-0 w-14 text-right">{relTime(run.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Schema hint */}
      <div className="rounded-xl border border-dashed border-border/50 bg-muted/10 p-4 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <FileText size={13} className="text-muted-foreground" />
          {t('settingsPage.hooks.configTitle', 'Config reference')}
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {t('settingsPage.hooks.configDesc', 'Hooks are defined in hooks.json at the project root or ~/.agents/hooks.json. Each hook is a shell/process command: exit 0 passes, exit 2 denies the action, anything else is an error. Hooks can inject additional context or override permission decisions.')}
        </p>
        <pre className="text-[10px] text-muted-foreground/80 bg-muted/30 rounded-lg p-3 overflow-x-auto font-mono leading-relaxed">
{`{
  "enabled": true,
  "events": {
    "PreToolUse": [{
      "matcher": "Bash|shell_executor",
      "hooks": [{"type": "command", "command": "python scripts/guard.py",
                "timeoutMs": 5000}]
    }]
  }
}`}
        </pre>
      </div>
    </div>
  )
}
