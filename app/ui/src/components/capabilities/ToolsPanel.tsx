// src/components/capabilities/ToolsPanel.tsx
// The tool table the agent actually sees, grouped by domain.
//
// Two things this panel is careful NOT to imply:
//
// 1. `riskLevel` from `GET /api/tools` is computed as
//    `classify_risk(tool.name, {})` — with EMPTY arguments. Real risk is
//    argument-dependent: `git push` classifies medium, but the same call with
//    `--force` is critical. So every badge here is a BASELINE, and the panel
//    says so rather than letting the user read it as the whole truth.
//
// 2. Risk alone decides nothing. The permission mode in the same response is
//    what determines whether a given tier runs silently, asks, or is refused.
//    Risk × mode is the effective behaviour, so the mode is stated up top with
//    what it means, not left as a bare word.
//
// There is deliberately no detail drawer: the endpoint returns no parameter
// schema (only name / domain / description / riskLevel), so a click-through
// would open on a single sentence the row already shows.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Wrench, ShieldAlert, Info } from 'lucide-react'
import { Badge } from '@components/ui/badge'
import { Button } from '@components/ui/button'
import { fetchJson, API_BASE } from '@lib/api'
import { cn } from '@lib/utils'

interface ToolInfo {
  name: string
  domain: string
  description: string
  /** Baseline only — see the file header. */
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | string
}

/** Most → least dangerous. Drives in-group ordering: the rows that can hurt
 *  you should be the ones you see first, not the ones starting with "a". */
const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

const RISK_CLASS: Record<string, string> = {
  critical: 'border-destructive/40 bg-destructive/10 text-destructive',
  high: 'border-destructive/30 bg-destructive/5 text-destructive/80',
  medium: 'border-warning/40 bg-warning/10 text-warning',
  low: 'border-border/40 bg-foreground/5 text-muted-foreground',
}

/** Copy lives under the page that owns this tab, matching
 *  `capabilitiesPage.plugins.*` / `.mcp.*`. */
const K = 'capabilitiesPage.toolsPanel'

export function ToolsPanel() {
  const { t } = useTranslation()
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [mode, setMode] = useState('')
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await fetchJson<{ tools: any[]; mode: string; count: number }>(
        `${API_BASE}/api/tools`,
      )
      setTools((d.tools || []).map((x: any) => ({
        name: String(x?.name ?? ''),
        domain: String(x?.domain ?? ''),
        description: String(x?.description ?? ''),
        riskLevel: String(x?.riskLevel ?? 'low'),
      })))
      setMode(String(d.mode || ''))
    } catch (e: any) {
      setError(e?.message || String(e))
      setTools([])
    } finally {
      setLoading(false)
      setHasLoaded(true)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Group by domain, keeping the backend's (domain, name) order for the groups
  // themselves but re-sorting rows inside each group by risk.
  const groups: Array<{ domain: string; items: ToolInfo[] }> = []
  for (const tool of tools) {
    const last = groups[groups.length - 1]
    if (last && last.domain === tool.domain) last.items.push(tool)
    else groups.push({ domain: tool.domain, items: [tool] })
  }
  for (const g of groups) {
    g.items.sort((a, b) =>
      (RISK_ORDER[a.riskLevel] ?? 9) - (RISK_ORDER[b.riskLevel] ?? 9)
      || a.name.localeCompare(b.name))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground leading-relaxed max-w-2xl">
          {t(`${K}.desc`, { count: tools.length })}
        </p>
        <Button
          size="sm" variant="ghost"
          onClick={refresh}
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
          className="h-7 px-2 shrink-0 active:transform-none"
        >
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
        </Button>
      </div>

      {/* Effective behaviour, not just a label. Risk tiers mean nothing without
          the mode they are evaluated under.

          The `: loading` branch is not decoration. `mode` only exists after
          `GET /api/tools` resolves, so with a bare `{mode && ...}` this whole card
          was ABSENT during the fetch and then INSERTED — everything below it jumped
          down ~90px in one frame, which is the flicker you see right at 「当前权限
          模式」 when the 工具 tab is opened. Reserving the same box while loading
          turns that insertion into a same-height swap. */}
      {mode ? (
        <div className="rounded-xl border border-border/50 bg-card/60 px-4 py-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold text-foreground">
              {t(`${K}.modeLabel`)}
            </span>
            <Badge variant="outline" className="h-5 font-mono text-[10px]">{mode}</Badge>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {t(`${K}.modeMeaning.${mode}`, { defaultValue: t(`${K}.modeMeaning.unknown`) })}
          </p>
          {/* Critical is the exception to every mode, including full access.
              Worth stating because "full = nothing asks" is otherwise the
              natural reading. */}
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
            {t(`${K}.criticalNote`)}
          </p>
        </div>
      ) : loading ? (
        <div
          aria-hidden
          className="rounded-xl border border-border/50 bg-card/60 px-4 py-3 space-y-1.5"
        >
          <div className="flex items-center gap-2">
            <div className="w-3.5 h-3.5 rounded bg-muted/40" />
            <div className="h-3 w-20 rounded bg-muted/50" />
            <div className="h-5 w-14 rounded bg-muted/30" />
          </div>
          <div className="h-3 w-full max-w-xl rounded bg-muted/30" />
          <div className="h-3 w-2/3 max-w-md rounded bg-muted/25" />
        </div>
      ) : null}

      <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground/70 leading-relaxed">
        <Info className="w-3 h-3 mt-0.5 shrink-0" />
        <p>{t(`${K}.baselineNote`)}</p>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Skeleton while the catalogue loads. Mirrors the real layout (group
          headers + tool rows) so the swap is a same-height replacement. Without
          it the panel renders nothing, then pops into a full list — a flicker
          every time the tab is opened. */}
      {loading && !hasLoaded && (
        <div className="space-y-4">
          {[0, 1].map((g) => (
            <div key={g} className="space-y-1.5">
              <div className="h-3 w-20 rounded bg-muted/50" />
              <div className="rounded-xl border border-border/40 divide-y divide-border/30">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-start gap-3 px-3 py-2.5">
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 w-24 rounded bg-muted/40" />
                      <div className="h-2.5 w-40 rounded bg-muted/30" />
                    </div>
                    <div className="h-4 w-12 rounded bg-muted/30" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && groups.length === 0 && hasLoaded && !error && (
        <p className="text-xs text-muted-foreground py-8 text-center">
          {t(`${K}.empty`)}
        </p>
      )}

      <div className="space-y-4">
        {!loading && groups.map(({ domain, items }) => (
          <section key={domain || '__ungrouped__'} className="space-y-1.5">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Wrench size={11} />
              {domain || t(`${K}.noDomain`)}
              <span className="text-muted-foreground/50 tabular-nums">{items.length}</span>
            </h3>
            <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden">
              {items.map((tool) => (
                <div key={tool.name} className="flex items-start gap-3 px-3 py-2.5 bg-card/40">
                  <div className="flex-1 min-w-0">
                    <code className="font-mono text-xs text-foreground">{tool.name}</code>
                    {tool.description && (
                      <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5 break-words">
                        {tool.description}
                      </p>
                    )}
                  </div>
                  <Badge
                    variant="outline"
                    title={t(`${K}.riskTooltip`)}
                    className={cn(
                      'shrink-0 h-5 text-[10px] font-medium',
                      RISK_CLASS[tool.riskLevel] || RISK_CLASS.low,
                    )}
                  >
                    {t(`${K}.risk.${tool.riskLevel}`, { defaultValue: tool.riskLevel })}
                  </Badge>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
