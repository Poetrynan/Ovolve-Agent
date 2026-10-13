import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BarChart3,
  Cpu,
  Flame,
  Database,
  Layers,
  Zap,
  TrendingUp,
  Coins,
  Clock,
  Sparkles,
  ArrowUpRight,
  ArrowDownLeft,
  ShieldCheck,
  Info,
  Activity,
  Gauge,
  Loader2,
} from 'lucide-react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'
import { API_BASE, apiFetch } from '@lib/api'
// Aliased: recharts exports a `Tooltip` too, and that one is already imported
// above for the charts.
import {
  Tooltip as HoverCard,
  TooltipContent as HoverCardContent,
  TooltipTrigger as HoverCardTrigger,
} from '@components/ui/tooltip'
import { cn } from '@/lib/utils'

interface UsageSummary {
  turns: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_creation: number
  cache_read: number
  /** What prompt caching SAVED versus full-rate input — already priced. */
  cache_saved_micros?: number
  sessions: number
  active_days: number
  /** in+out(+reasoning when billed separately) — convention-aware, from SQL. */
  total_tokens: number
  /** 0-1 FRACTION. Multiply by 100 to render a percentage. */
  cache_hit_rate: number
  total_cost_micros?: number
  cost_approximate?: boolean
  favorite_model: string
  current_streak_days: number
  latency_p50_ms?: number
  latency_p95_ms?: number
  latency_max_ms?: number
  latency_samples?: number
}

interface DailyRow {
  date: string
  turns: number
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  tokens: number
  cache_read: number
  cost_micros?: number
}

/** One access path that served a model: which provider entry, and how much. */
interface ModelSource {
  provider_id: string
  /** Vendor name resolved by the backend registry. "" when unnameable. */
  provider_label?: string
  requests: number
  tokens: number
  cost_micros?: number
}

interface ModelRow {
  /** Bare model id — the backend groups by model, not by `provider:model`. */
  model_id: string
  /** Dominant raw `provider:model` string, kept for debugging. */
  raw_model_id?: string
  /** Set only when exactly one provider served this model; "" otherwise. */
  provider_label?: string
  sources?: ModelSource[]
  requests: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens?: number
  cost_micros?: number
  tokens: number
  share: number
}

interface TurnRow {
  id: string
  session_id: string
  /** Backend column is `turn_id` — the old `message_id` never existed. */
  turn_id: string
  model_id: string
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cost_micros?: number
  latency_ms?: number
  created_at: number
  turnIndex?: number
}

interface UsageStats {
  days: number
  summary: UsageSummary
  daily: DailyRow[]
  byModel: ModelRow[]
  recentTurns?: TurnRow[]
}

const RANGES = [
  { days: 7, label: '7' },
  { days: 30, label: '30' },
  { days: 90, label: '90' },
  { days: 365, label: '365' },
] as const

/**
 * Format token-scale numbers with k/M units ONLY — never raw hundreds.
 * Sub-1k values ceil to the next tenth of a k (865 -> "0.9k") so a real
 * value can't collapse to "0.0k". Counts (turns/sessions/days) are NOT
 * formatted through here; they render as plain integers.
 */
function fmt(n: number | undefined | null): string {
  if (!n || n <= 0) return '0k'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return `${(Math.ceil(n / 100) / 10).toFixed(1)}k`
}

/** Format currency from micro-dollars. */
function fmtCost(micros: number | undefined | null): string {
  if (!micros || micros <= 0) return '$0.00'
  const dollars = micros / 1_000_000
  if (dollars < 0.0001) return '<$0.0001'
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`
  if (dollars < 1) return `$${dollars.toFixed(3)}`
  return `$${dollars.toFixed(2)}`
}

/** Format latency into friendly string. */
function fmtLatency(ms: number | undefined | null): string {
  if (!ms || ms <= 0) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Round `vals` to integers that sum exactly to `target` (largest remainder).
 * Independent Math.round calls sum to 99-101, and a composition card whose
 * rows add up to 103% reads as broken arithmetic even when each row is fine.
 */
function roundedShares(vals: number[], target = 100): number[] {
  const raw = vals.map((v) => v * target)
  const out = raw.map(Math.floor)
  let left = target - out.reduce((a, b) => a + b, 0)
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac)
  for (const { i } of order) {
    if (left <= 0) break
    out[i] += 1
    left -= 1
  }
  return out
}

/**
 * Badge naming the access path(s) a model was served through.
 *
 * Replaces a hardcoded 9-entry provider lookup that uppercased anything it did
 * not recognise — which is how the internal `__config__` sentinel came to be
 * rendered as `__CONFIG__` on screen. Vendor names now arrive resolved from the
 * backend registry; the only thing decided here is the wording for the cases
 * with no single vendor, and that lives in the locale files.
 *
 * When one model was reached through several provider entries the rows are
 * merged (that is the point — it is one model), so the per-source split would
 * otherwise be lost. It moves to a hover instead of being deleted: nobody needs
 * three credential paths in their line of sight, but the person debugging why a
 * model has two prices does need them one gesture away.
 */
function ProviderBadge({
  sources,
  className,
}: {
  sources: ModelSource[]
  className?: string
}) {
  const { t } = useTranslation()

  // The backend leaves the label empty when it has no vendor name to give. Two
  // different situations produce that, and collapsing them into one "unknown"
  // would throw away the actionable half: the config.json-seeded entry IS
  // identifiable, it just has no name until config.json supplies `provider`.
  //
  // When it DOES have a name, it still gets annotated. config.json naming its
  // provider `longcat` while a registered provider is called `LongCat (美团)`
  // otherwise lists two near-identical lines and reads like a rendering bug
  // rather than the two genuinely distinct access paths it is.
  const sourceName = (s?: ModelSource): string => {
    const label = (s?.provider_label || '').trim()
    if (s?.provider_id === '__config__') {
      return label ? t('usage.configSourceNamed', { name: label }) : t('usage.configSource')
    }
    return label || t('usage.unknownSource')
  }

  const multi = sources.length > 1
  const text = multi
    ? t('usage.multiSource', { count: sources.length })
    : sourceName(sources[0])

  if (!multi) return <span className={className}>{text}</span>

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <span className={cn(className, 'cursor-help decoration-dotted underline-offset-2 underline')}>
          {text}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="top" className="max-w-[260px]">
        <p className="text-[11px] font-semibold mb-1">{t('usage.multiSourceTitle')}</p>
        <ul className="space-y-0.5">
          {sources.map((s) => (
            <li key={s.provider_id || 'unknown'} className="text-[11px] flex justify-between gap-3 font-mono">
              <span className="truncate">{sourceName(s)}</span>
              <span className="shrink-0 text-muted-foreground">
                {s.requests} · {fmtCost(s.cost_micros)}
              </span>
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  )
}

export default function UsagePage() {
  const { t } = useTranslation()
  const [range, setRange] = useState<number>(30)
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiFetch(`${API_BASE}/api/usage/stats?days=${range}`)
      .then((r) => {
        // A non-2xx (or a 200 carrying an error body) used to be set as the
        // stats wholesale, and `stats.summary === undefined` then rendered a
        // silently blank page. Fail loudly into the error banner instead.
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d) => {
        if (!d || typeof d !== 'object' || !d.summary) {
          throw new Error('malformed payload')
        }
        if (!cancelled) {
          setStats(d as UsageStats)
          setError(null)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [range])

  const s = stats?.summary

  return (
    <div className="container mx-auto py-8 px-4 max-w-6xl space-y-8 animate-fade-in">
      {/* Header with Title & Range Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-border/40">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-foreground/10 text-foreground border border-border/40 shadow-xs">
              <BarChart3 size={22} className="stroke-[2.2]" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-heading font-extrabold tracking-tight">
              {t('usage.title')}
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 ml-1">
            {t('usage.subtitle')}
          </p>
        </div>

        {/* Range Switcher — the active button spins while a new range loads,
            so switching no longer feels like a dead click. */}
        <div className="flex items-center self-start sm:self-auto bg-muted/50 p-1 rounded-xl border border-border/40 shadow-xs">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              onClick={() => setRange(r.days)}
              disabled={loading}
              className={cn(
                'flex items-center gap-1 px-3.5 py-1.5 rounded-lg text-xs font-semibold select-none transition-colors duration-150',
                range === r.days
                  ? 'bg-card text-foreground shadow-xs border border-border/50 font-bold'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/60 border border-transparent',
                loading && range === r.days && 'opacity-80',
              )}
            >
              {loading && range === r.days && <Loader2 size={11} className="animate-spin" />}
              {r.days === 365 ? t('usage.lastYear') : t('usage.lastNDays', { n: r.label })}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center gap-2 shadow-xs">
          <Info size={16} />
          <span>{t('usage.loadError')}: {error}</span>
        </div>
      )}

      {loading && !stats ? (
        /* Loading Skeleton */
        <div className="space-y-6 animate-pulse">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-28 rounded-2xl border border-border/40 bg-card/40 p-5" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 h-72 rounded-2xl border border-border/40 bg-card/40" />
            <div className="lg:col-span-4 h-72 rounded-2xl border border-border/40 bg-card/40" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-64 rounded-2xl border border-border/40 bg-card/40" />
            <div className="h-64 rounded-2xl border border-border/40 bg-card/40" />
          </div>
        </div>
      ) : s ? (
        <>
          {/* 1. Hero KPI Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Card 1: Total Tokens */}
            <div className="relative overflow-hidden rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md p-5 shadow-xs transition-all hover:shadow-md hover:border-primary/30 group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-primary/5 rounded-full blur-2xl group-hover:bg-primary/10 transition-colors pointer-events-none" />
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                <span className="font-medium">{t('usage.totalTokens')}</span>
                <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                  <Zap size={14} className="fill-primary/20" />
                </div>
              </div>
              <div className="text-3xl font-heading font-extrabold tracking-tight text-foreground">
                {fmt(s.total_tokens)}
              </div>
              <div className="flex items-center gap-1.5 mt-2.5 text-[11px] text-muted-foreground/80 truncate">
                {t('usage.inOutThink', {
                  i: fmt(s.input_tokens),
                  o: fmt(s.output_tokens),
                  r: fmt(s.reasoning_tokens),
                })}
              </div>
            </div>

            {/* Card 2: Turns & Sessions */}
            <div className="relative overflow-hidden rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md p-5 shadow-xs transition-all hover:shadow-md hover:border-violet-500/30 group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-violet-500/5 rounded-full blur-2xl group-hover:bg-violet-500/10 transition-colors pointer-events-none" />
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                <span className="font-medium">{t('usage.turns')}</span>
                <div className="p-1.5 rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
                  <Layers size={14} />
                </div>
              </div>
              <div className="text-3xl font-heading font-extrabold tracking-tight text-foreground">
                {s.turns} <span className="text-sm font-normal text-muted-foreground">{t('usage.turnsUnit')}</span>
              </div>
              <div className="flex items-center gap-1.5 mt-2.5 text-[11px] text-muted-foreground/80">
                <span>{t('usage.sessionsCount', { n: s.sessions })}</span>
                <span>·</span>
                <span>{t('usage.activeDaysCount', { n: s.active_days })}</span>
              </div>
            </div>

            {/* Card 3: Cache Hit Rate */}
            <div className="relative overflow-hidden rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md p-5 shadow-xs transition-all hover:shadow-md hover:border-emerald-500/30 group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl group-hover:bg-emerald-500/10 transition-colors pointer-events-none" />
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                <span className="font-medium">{t('usage.cacheHitRate')}</span>
                <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <Database size={14} />
                </div>
              </div>
              <div className="text-3xl font-heading font-extrabold tracking-tight text-foreground flex items-baseline gap-2">
                {/* Backend sends a 0-1 fraction — ×100 here, and everywhere. */}
                <span>{Math.round((s.cache_hit_rate || 0) * 100)}%</span>
                {s.cache_hit_rate > 0 && (
                  <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-md">
                    {t('usage.cacheActive')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 mt-2.5 text-[11px] text-muted-foreground/80 truncate">
                <span>{t('usage.cacheReadTokens', { v: fmt(s.cache_read) })}</span>
                {(s.cache_saved_micros || 0) > 0 && (
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">
                    · {t('usage.cacheSaved', { v: fmtCost(s.cache_saved_micros) })}
                  </span>
                )}
              </div>
            </div>

            {/* Card 4: Estimated Spend & Streak */}
            <div className="relative overflow-hidden rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md p-5 shadow-xs transition-all hover:shadow-md hover:border-amber-500/30 group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-2xl group-hover:bg-amber-500/10 transition-colors pointer-events-none" />
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                <span className="font-medium">{t('usage.estimatedCost')}</span>
                <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  <Coins size={14} />
                </div>
              </div>
              <div className="text-3xl font-heading font-extrabold tracking-tight text-foreground flex items-baseline gap-1.5">
                <span>{fmtCost(s.total_cost_micros)}</span>
                <span className="text-[11px] font-normal text-muted-foreground font-sans">
                  {s.cost_approximate ? `(${t('usage.costApprox')})` : ''}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-2.5 text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                <Flame size={12} className="fill-amber-500" />
                <span>{t('usage.streak')}: {t('usage.streakDays', { n: s.current_streak_days })}</span>
              </div>
            </div>
          </div>

          {/* 2. Middle Section: Daily Token Throughput & Token Composition */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left: Daily Token Trend Interactive Chart */}
            <div className="lg:col-span-8 rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md p-6 shadow-xs flex flex-col space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                    <TrendingUp size={16} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-foreground">{t('usage.dailyTrend')}</h3>
                    <p className="text-xs text-muted-foreground">{t('usage.dailyTrendSubtitle', { n: range })}</p>
                  </div>
                </div>

                <div className="hidden sm:flex items-center gap-3 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-foreground" />
                    <span className="text-muted-foreground text-[11px]">{t('usage.legendInput')}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-amber-500" />
                    <span className="text-muted-foreground text-[11px]">{t('usage.legendReasoning')}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-emerald-500" />
                    <span className="text-muted-foreground text-[11px]">{t('usage.legendOutput')}</span>
                  </div>
                </div>
              </div>

              {/* Chart Component */}
              <DailyTrendChart daily={stats.daily} days={range} recentTurns={stats.recentTurns} />
            </div>

            {/* Right: Token Composition Breakdown Card */}
            <div className="lg:col-span-4 rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md p-6 shadow-xs flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <div className="p-1.5 rounded-lg bg-violet-500/10 text-violet-500">
                    <Cpu size={16} />
                  </div>
                  <h3 className="text-sm font-bold text-foreground">{t('usage.tokenBreakdown')}</h3>
                </div>

                <TokenComposition summary={s} />
              </div>

              {/* Cache Insight Tip */}
              <div className="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-muted-foreground flex items-start gap-2.5 leading-relaxed">
                <ShieldCheck size={16} className="text-emerald-500 shrink-0 mt-0.5" />
                <span>{t('usage.promptCacheHint')}</span>
              </div>
            </div>
          </div>

          {/* 3. Bottom Section: Model Intelligence & Activity Heatmap */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left: Model Intelligence Breakdown */}
            <div className="lg:col-span-6 rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md p-6 shadow-xs flex flex-col space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                    <Sparkles size={16} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-foreground">{t('usage.byModel')}</h3>
                    <p className="text-xs text-muted-foreground">{t('usage.byModelSubtitle')}</p>
                  </div>
                </div>
              </div>

              <ModelBreakdownList rows={stats.byModel} />
            </div>

            {/* Right: Activity Calendar Heatmap & Diagnostics */}
            <div className="lg:col-span-6 rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md p-6 shadow-xs flex flex-col space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-500">
                    <Flame size={16} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-foreground">{t('usage.activity')}</h3>
                    <p className="text-xs text-muted-foreground">{t('usage.activitySubtitle')}</p>
                  </div>
                </div>

                {/* Latency Chips — tooltip carries the REAL percentiles, not
                    stale sample numbers. */}
                {s.latency_p50_ms !== undefined && s.latency_p50_ms > 0 && (
                  <div
                    title={t('usage.latencyTooltip', {
                      p50: fmtLatency(s.latency_p50_ms),
                      p95: fmtLatency(s.latency_p95_ms ?? 0),
                    })}
                    className="flex items-center gap-2 text-[11px] text-muted-foreground bg-muted/40 px-2.5 py-1 rounded-lg border border-border/40 cursor-help transition-colors hover:border-foreground/30"
                  >
                    <Clock size={12} className="text-foreground" />
                    <span>{t('usage.medianLabel')}: <strong className="font-mono text-foreground">{fmtLatency(s.latency_p50_ms)}</strong></span>
                    {s.latency_p95_ms !== undefined && s.latency_p95_ms > 0 && (
                      <>
                        <span>·</span>
                        <span>{t('usage.tailLabel')}: <strong className="font-mono text-foreground">{fmtLatency(s.latency_p95_ms)}</strong></span>
                      </>
                    )}
                  </div>
                )}
              </div>

              <ActivityHeatmap daily={stats.daily} days={range} />
            </div>
          </div>

          {/* Statistics scope footnote — the numbers above only reconcile
              with a bill if the reader knows what a "request" is. */}
          <p className="text-[10.5px] text-muted-foreground/70 leading-relaxed px-1">
            {t('usage.statScope')}
          </p>
        </>
      ) : !error ? (
        <div className="py-16 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <BarChart3 size={28} className="opacity-40" />
          <p className="text-sm">{t('usage.noData')}</p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Mathematical Cartesian Coordinate Spline & Histogram Throughput Chart.
 * Features exact Y-axis coordinate ticks, smooth spline curve, and rock-solid zero-jitter container.
 */
function DailyTrendChart({
  daily,
  days,
  recentTurns = [],
}: {
  daily: DailyRow[]
  days: number
  recentTurns?: TurnRow[]
}) {
  const { t } = useTranslation()

  // Prioritize turns if <= 3 active days, else daily spline
  const activeDaysCount = useMemo(() => daily.filter((d) => (d.tokens || 0) > 0).length, [daily])
  const [viewMode, setViewMode] = useState<'daily' | 'turns' | 'ratio'>(() => {
    return activeDaysCount <= 3 && recentTurns.length > 0 ? 'turns' : 'daily'
  })

  // Re-run the default-mode heuristic when the RANGE changes: the component
  // stays mounted across switches, so the mount-only initializer kept a
  // turns-mode chosen under a sparse range stuck while viewing a dense one.
  useEffect(() => {
    setViewMode(activeDaysCount <= 3 && recentTurns.length > 0 ? 'turns' : 'daily')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days])

  const [hoveredTurn, setHoveredTurn] = useState<TurnRow | null>(null)
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null)

  // 1. Daily Time-series Dataset with Math Coordinate Points
  const dailyData = useMemo(() => {
    const byDate = new Map(daily.map((d) => [d.date, d]))
    const out: DailyRow[] = []
    const today = new Date()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const existing = byDate.get(iso)
      if (existing) {
        out.push(existing)
      } else {
        out.push({
          date: iso,
          turns: 0,
          tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cache_read: 0,
        })
      }
    }
    return out
  }, [daily, days])

  const maxDailyTokens = useMemo(() => {
    return Math.max(...dailyData.map((d) => d.tokens || 0), 100)
  }, [dailyData])

  // 2. Turn-by-Turn Dataset (chronological). The backend hands back the
  // NEWEST rows first; sort ascending so the timeline reads left→right.
  const turnData = useMemo(() => {
    if (!recentTurns || recentTurns.length === 0) return []
    const list = [...recentTurns].sort((a, b) => a.created_at - b.created_at)
    return list.map((t, idx) => {
      const input = t.input_tokens || 0
      const output = t.output_tokens || 0
      const reasoning = t.reasoning_tokens || 0
      return {
        ...t,
        turnIndex: idx + 1,
        total: input + output + reasoning,
      }
    })
  }, [recentTurns])

  const maxTurnTokens = useMemo(() => {
    return Math.max(...turnData.map((t) => t.total), 100)
  }, [turnData])

  const activeHoveredDay = hoveredDayIdx !== null ? dailyData[hoveredDayIdx] : null

  return (
    <div className="space-y-4 select-none">
      {/* Sub-header: View Switcher Tabs & Live Tooltip Readout */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-1">
        {/* Segmented View Mode Buttons */}
        <div className="inline-flex items-center p-0.5 rounded-xl bg-muted/60 border border-border/50 shadow-2xs self-start">
          <button
            type="button"
            onClick={() => setViewMode('daily')}
            className={cn(
              'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors flex items-center gap-1.5',
              viewMode === 'daily'
                ? 'bg-card text-foreground font-bold shadow-xs border border-border/40'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <TrendingUp size={12} className={viewMode === 'daily' ? 'text-foreground' : 'text-muted-foreground'} />
            <span>{t('usage.viewDaily', { n: days })}</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('turns')}
            className={cn(
              'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors flex items-center gap-1.5',
              viewMode === 'turns'
                ? 'bg-card text-foreground font-bold shadow-xs border border-border/40'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Activity size={12} className={viewMode === 'turns' ? 'text-foreground' : 'text-muted-foreground'} />
            <span>{t('usage.viewTurns', { n: turnData.length })}</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('ratio')}
            className={cn(
              'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors flex items-center gap-1.5',
              viewMode === 'ratio'
                ? 'bg-card text-foreground font-bold shadow-xs border border-border/40'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Gauge size={12} className={viewMode === 'ratio' ? 'text-foreground' : 'text-muted-foreground'} />
            <span>{t('usage.viewRatio')}</span>
          </button>
        </div>

        {/* Dynamic Mathematical Tooltip / Status Display */}
        <div className="h-6 flex items-center text-xs font-mono">
          {viewMode === 'daily' && activeHoveredDay && (
            <div className="flex items-center gap-2.5 animate-fade-in">
              <span className="font-sans font-bold text-foreground">{activeHoveredDay.date}</span>
              <span className="text-foreground">{t('usage.throughput')}: {fmt(activeHoveredDay.tokens)}</span>
              <span className="text-muted-foreground">({t('usage.turnsOf', { n: activeHoveredDay.turns })})</span>
            </div>
          )}

          {viewMode === 'turns' && hoveredTurn && (
            <div className="flex items-center gap-2.5 animate-fade-in">
              <span className="font-sans font-bold text-foreground">{t('usage.turnN', { n: hoveredTurn.turnIndex ?? 0 })}</span>
              <span className="text-foreground">{t('usage.inShort')}: {fmt(hoveredTurn.input_tokens)}</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{t('usage.outShort')}: {fmt(hoveredTurn.output_tokens)}</span>
              {hoveredTurn.latency_ms !== undefined && hoveredTurn.latency_ms > 0 && (
                <span className="text-muted-foreground">({fmtLatency(hoveredTurn.latency_ms)})</span>
              )}
            </div>
          )}

          {!activeHoveredDay && !hoveredTurn && (
            <span className="text-[11px] text-muted-foreground font-sans">
              {viewMode === 'daily'
                ? t('usage.peakHintDaily', { v: fmt(maxDailyTokens) })
                : viewMode === 'turns'
                  ? t('usage.peakHintTurns', { v: fmt(maxTurnTokens) })
                  : t('usage.ratioHint')}
            </span>
          )}
        </div>
      </div>

      {/* Fixed Height Container to Guarantee ZERO Jitter on Click */}
      <div className="h-[175px] min-h-[175px] max-h-[175px] w-full flex flex-col justify-between">
        {/* VIEW 1: Recharts Standard Monotone Area Chart */}
        {viewMode === 'daily' && (
          <div className="h-full w-full pt-1">
            <ResponsiveContainer width="100%" height={175}>
              <AreaChart
                data={dailyData}
                margin={{ top: 8, right: 12, left: -20, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="rechartsThroughputGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--foreground))" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="hsl(var(--foreground))" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="hsl(var(--border) / 0.35)"
                />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={{ stroke: 'hsl(var(--border) / 0.4)' }}
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={(dateStr: string) => {
                    const parts = dateStr.split('-')
                    return `${parts[1]}/${parts[2]}`
                  }}
                  minTickGap={30}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={(val: number) => fmt(val)}
                  domain={[0, 'auto']}
                  width={50}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null
                    const d = payload[0].payload as DailyRow
                    return (
                      <div className="p-2.5 rounded-xl bg-card border border-border/60 shadow-lg text-xs font-mono space-y-1 z-50">
                        <div className="font-sans font-bold text-foreground">{d.date}</div>
                        <div className="text-foreground">{t('usage.throughput')}: <strong className="font-bold">{fmt(d.tokens)}</strong></div>
                        <div className="text-muted-foreground text-[11px]">{t('usage.turnsOf', { n: d.turns })}</div>
                        {d.cost_micros !== undefined && d.cost_micros > 0 && (
                          <div className="text-emerald-600 dark:text-emerald-400 text-[11px]">{t('usage.costLabel')}: {fmtCost(d.cost_micros)}</div>
                        )}
                      </div>
                    )
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="tokens"
                  stroke="hsl(var(--foreground))"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#rechartsThroughputGrad)"
                  activeDot={{ r: 4.5, fill: 'hsl(var(--foreground))', stroke: 'hsl(var(--card))', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* VIEW 2: Recharts Stacked Histogram for Turn Breakdown.
            Reasoning is a stack layer now — it was included in the axis max
            but never drawn, so every reasoning-model bar came up short. */}
        {viewMode === 'turns' && (
          <div className="h-full w-full pt-1">
            {turnData.length > 0 ? (
              <ResponsiveContainer width="100%" height={175}>
                <BarChart
                  data={turnData.map((row) => ({
                    ...row,
                    name: t('usage.turnN', { n: row.turnIndex }),
                  }))}
                  margin={{ top: 8, right: 12, left: -20, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="hsl(var(--border) / 0.35)"
                  />
                  <XAxis
                    dataKey="name"
                    tickLine={false}
                    axisLine={{ stroke: 'hsl(var(--border) / 0.4)' }}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(val: number) => fmt(val)}
                    domain={[0, 'auto']}
                    width={50}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || payload.length === 0) return null
                      const t2 = payload[0].payload as TurnRow & { turnIndex: number }
                      return (
                        <div className="p-2.5 rounded-xl bg-card border border-border/60 shadow-lg text-xs font-mono space-y-1 z-50">
                          <div className="font-sans font-bold text-foreground">{t('usage.turnInteraction', { n: t2.turnIndex })}</div>
                          <div className="text-foreground">{t('usage.promptIn')}: <strong className="font-bold">{fmt(t2.input_tokens)}</strong></div>
                          {(t2.reasoning_tokens || 0) > 0 && (
                            <div className="text-amber-600 dark:text-amber-400">{t('usage.reasoningLabel')}: <strong className="font-bold">{fmt(t2.reasoning_tokens)}</strong></div>
                          )}
                          <div className="text-emerald-600 dark:text-emerald-400">{t('usage.completionOut')}: <strong className="font-bold">{fmt(t2.output_tokens)}</strong></div>
                          {t2.latency_ms !== undefined && t2.latency_ms > 0 && (
                            <div className="text-muted-foreground text-[11px]">{t('usage.latencyLabel')}: {fmtLatency(t2.latency_ms)}</div>
                          )}
                        </div>
                      )
                    }}
                  />
                  <Bar
                    dataKey="input_tokens"
                    name={t('usage.promptIn')}
                    stackId="turnStack"
                    fill="hsl(var(--foreground))"
                    maxBarSize={28}
                  />
                  {(turnData.some((x) => (x.reasoning_tokens || 0) > 0)) && (
                    <Bar
                      dataKey="reasoning_tokens"
                      name={t('usage.reasoningLabel')}
                      stackId="turnStack"
                      fill="#f59e0b"
                      maxBarSize={28}
                    />
                  )}
                  <Bar
                    dataKey="output_tokens"
                    name={t('usage.completionOut')}
                    stackId="turnStack"
                    fill="#10b981"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={28}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
                {t('usage.noTurnsData')}
              </div>
            )}
          </div>
        )}

        {/* VIEW 3: Interactive Ratio & Energy Conversion Flow Visualizer */}
        {viewMode === 'ratio' && (() => {
          // `??` not `||`: a day with a RECORDED input of 0 is a real zero;
          // falling back to its total (which contains output) inflated the
          // input share of the whole period.
          const totalIn = daily.reduce((a, c) => a + (c.input_tokens ?? 0), 0)
          const totalOut = daily.reduce((a, c) => a + (c.output_tokens ?? 0), 0)
          const totalRsn = daily.reduce((a, c) => a + (c.reasoning_tokens ?? 0), 0)
          const totalAll = totalIn + totalOut + totalRsn || 1
          const inPct = ((totalIn / totalAll) * 100).toFixed(1)
          const outPct = ((totalOut / totalAll) * 100).toFixed(1)
          // 0 output means the ratio does not exist — display "—" instead of
          // the old `|| 1` which claimed a 1:1 yield out of thin air.
          const ratioMultiplier = totalOut > 0 ? Math.round(totalIn / totalOut) : null
          const ratioText = ratioMultiplier !== null ? `1 : ${ratioMultiplier}` : '—'

          return (
            <div className="h-full w-full flex flex-col justify-between p-3 rounded-2xl bg-muted/20 border border-border/40">
              {/* Flow Conversion Pipeline */}
              <div className="grid grid-cols-12 gap-2 items-center">
                {/* Left: Input Context Card */}
                <div className="col-span-5 p-2 rounded-xl bg-card border border-border/50 shadow-2xs space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <ArrowDownLeft size={12} className="text-muted-foreground" />
                      <span className="text-[10.5px] font-medium text-muted-foreground">{t('usage.promptCtx')}</span>
                    </div>
                    <span className="text-[9.5px] font-bold font-mono px-1.5 py-0.2 rounded bg-muted text-foreground">
                      {inPct}%
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-base sm:text-lg font-heading font-extrabold tracking-tight text-foreground">
                      {fmt(totalIn)}
                    </span>
                    <span className="text-[9.5px] text-muted-foreground truncate">{t('usage.ctxHint')}</span>
                  </div>
                </div>

                {/* Center: Conversion Multiplier Node */}
                <div className="col-span-2 flex flex-col items-center justify-center">
                  <div className="p-1 rounded-full bg-foreground/10 text-foreground border border-border/50 shadow-xs mb-0.5">
                    <Zap size={12} />
                  </div>
                  <span className="text-[9px] font-mono font-bold text-foreground text-center leading-tight">
                    {ratioText}
                  </span>
                  <span className="text-[8px] text-muted-foreground scale-90">{t('usage.genRatio')}</span>
                </div>

                {/* Right: Output Completion Card */}
                <div className="col-span-5 p-2 rounded-xl bg-card border border-border/50 shadow-2xs space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <ArrowUpRight size={12} className="text-emerald-500" />
                      <span className="text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">{t('usage.completionGen')}</span>
                    </div>
                    <span className="text-[9.5px] font-bold font-mono px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                      {outPct}%
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-base sm:text-lg font-heading font-extrabold tracking-tight text-emerald-600 dark:text-emerald-400">
                      {fmt(totalOut)}
                    </span>
                    <span className="text-[9.5px] text-muted-foreground truncate">{t('usage.outHint')}</span>
                  </div>
                </div>
              </div>

              {/* Continuous Proportional Spectrum Bar */}
              <div className="space-y-1 pt-1">
                <div className="h-2 w-full rounded-full overflow-hidden bg-muted/60 flex gap-0.5 p-0.5">
                  <div
                    style={{ width: `${Math.max(2, Number(inPct))}%` }}
                    className="h-full rounded-full bg-foreground transition-all duration-300"
                    title={`${t('usage.legendInput')}: ${fmt(totalIn)} (${inPct}%)`}
                  />
                  <div
                    style={{ width: `${Math.max(2, Number(outPct))}%` }}
                    className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                    title={`${t('usage.legendOutput')}: ${fmt(totalOut)} (${outPct}%)`}
                  />
                </div>
              </div>

              {/* Bottom Statistical Insight */}
              <div className="flex items-center justify-between text-[10.5px] text-muted-foreground px-1 pt-1 border-t border-border/30">
                <span className="truncate">
                  {ratioMultiplier !== null
                    ? t('usage.efficiencySentence', { n: ratioMultiplier })
                    : t('usage.efficiencyNoOutput')}
                </span>
                <span className="font-mono text-[10px] shrink-0 text-muted-foreground/80">
                  {t('usage.totalThroughput')} {fmt(totalAll)}
                </span>
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

/**
 * Recharts Proportional Donut and Table Breakdown.
 *
 * The pie's denominator is the SUM OF ITS OWN SLICES (in+out+reasoning+cache),
 * not `summary.total_tokens` — that field convention-corrects reasoning away
 * and excludes cache, so using it made the four slices add up to >100%.
 * Percentages use largest-remainder rounding so the rows sum to exactly 100.
 */
function TokenComposition({ summary }: { summary: UsageSummary }) {
  const { t } = useTranslation()

  const rawParts = [
    {
      key: 'input',
      label: t('usage.input'),
      val: summary.input_tokens || 0,
      color: 'bg-foreground',
      fill: 'hsl(var(--foreground))',
      textColor: 'text-foreground',
    },
    {
      key: 'output',
      label: t('usage.output'),
      val: summary.output_tokens || 0,
      color: 'bg-emerald-500',
      fill: '#10b981',
      textColor: 'text-emerald-600 dark:text-emerald-400',
    },
    {
      key: 'reasoning',
      label: t('usage.reasoning'),
      val: summary.reasoning_tokens || 0,
      color: 'bg-amber-500',
      fill: '#f59e0b',
      textColor: 'text-amber-600 dark:text-amber-400',
    },
    {
      key: 'cache',
      label: t('usage.cacheRead'),
      val: summary.cache_read || 0,
      color: 'bg-muted-foreground/60',
      fill: 'hsl(var(--muted-foreground) / 0.6)',
      textColor: 'text-muted-foreground',
    },
  ]

  const pieTotal = rawParts.reduce((a, p) => a + p.val, 0)
  const pcts = roundedShares(rawParts.map((p) => (pieTotal > 0 ? p.val / pieTotal : 0)))
  const parts = rawParts.map((p, i) => ({ ...p, pct: pcts[i] }))

  const pieData = parts.filter((p) => p.val > 0)
  // Data-driven headline: whichever slice actually leads, instead of a
  // hardcoded "input dominates" that was wrong whenever output > input.
  const dominant = rawParts.reduce((a, b) => (b.val > a.val ? b : a), rawParts[0])

  return (
    <div className="space-y-3 select-none">
      {/* Upper: Recharts Donut Chart & Key Proportions */}
      <div className="flex items-center justify-between gap-4 p-2.5 rounded-xl bg-muted/20 border border-border/40">
        <div className="w-20 h-20 shrink-0 relative flex items-center justify-center">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={pieData.length > 0 ? pieData : [{ val: 1, fill: 'hsl(var(--muted))' }]}
                dataKey="val"
                innerRadius={24}
                outerRadius={36}
                paddingAngle={3}
                stroke="none"
              >
                {pieData.map((entry) => (
                  <Cell key={entry.key} fill={entry.fill} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-[10px] font-bold font-mono text-foreground leading-none">{fmt(summary.total_tokens)}</span>
            <span className="text-[8px] text-muted-foreground scale-90">{t('usage.totalLabel')}</span>
          </div>
        </div>

        {/* Proportional Insight Text */}
        <div className="flex-1 space-y-1 min-w-0">
          <div className="text-xs font-bold text-foreground truncate">
            {t('usage.dominant', { name: dominant.label })}
          </div>
          <p className="text-[10.5px] text-muted-foreground leading-relaxed">
            {t('usage.compositionSentence', { in: parts[0].pct, out: parts[1].pct })}
          </p>
          <div className="flex items-center gap-1.5 pt-0.5">
            <span className="text-[9.5px] font-mono px-1.5 py-0.2 rounded bg-muted text-muted-foreground border border-border/40">
              {/* Fraction from the backend — ×100, same as the KPI card. */}
              {t('usage.cacheReuse')} {Math.round((summary.cache_hit_rate || 0) * 100)}%
            </span>
          </div>
        </div>
      </div>

      {/* Detailed List */}
      <div className="space-y-1.5 pt-0.5">
        {parts.map((p) => (
          <div key={p.key} className="flex items-center justify-between text-xs py-1 px-1.5 rounded-lg hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className={cn('w-2.5 h-2.5 rounded-xs shrink-0', p.color)} />
              <span className="text-foreground/90 font-medium truncate">{p.label}</span>
            </div>
            <div className="flex items-center gap-3 font-mono shrink-0 ml-2">
              <span className="text-foreground font-semibold">{fmt(p.val)}</span>
              <span className={cn('text-[11px] font-medium min-w-9 text-right tabular-nums', p.textColor)}>
                {p.val > 0 && p.pct === 0 ? '< 1%' : `${p.pct}%`}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Model Intelligence List:
 * - When N > 1: Renders high-density ranked leaderboard with macro spectrum bar and internal scroll.
 * - When N = 1: Renders comprehensive single-model intelligence panel without empty blank space.
 */
function ModelBreakdownList({ rows }: { rows: ModelRow[] }) {
  const { t } = useTranslation()

  const aggregatedRows = useMemo(() => {
    if (!rows || rows.length === 0) return []
    // The backend already returns one row per model with its provider breakdown
    // in `sources`, so there is nothing left to merge here. This used to re-group
    // on `provider___name` after parsing the id in the browser, which split a
    // single model into one row per access path — three rows reading 53/39/7%
    // for what was one model at 100%.
    const total = rows.reduce((acc, cur) => acc + (cur.tokens || 0), 0) || 1
    return rows.map((m) => ({
      key: m.model_id,
      name: m.model_id,
      sources: m.sources ?? [],
      requests: m.requests || 0,
      input_tokens: m.input_tokens || 0,
      output_tokens: m.output_tokens || 0,
      reasoning_tokens: m.reasoning_tokens || 0,
      cost_micros: m.cost_micros || 0,
      tokens: m.tokens || 0,
      share: typeof m.share === 'number' ? m.share : (m.tokens || 0) / total,
    }))
  }, [rows])

  if (aggregatedRows.length === 0) {
    return (
      <div className="h-[185px] text-center text-xs text-muted-foreground flex flex-col items-center justify-center gap-2">
        <Cpu size={24} className="text-muted-foreground/40" />
        <span>{t('usage.noData')}</span>
      </div>
    )
  }

  // CASE 1: Single Model - Detailed Deep-Dive Panel (No awkward blank gap)
  if (aggregatedRows.length === 1) {
    const m = aggregatedRows[0]
    // requests=0 means the average is unknown, not "the total" — the old
    // fallback displayed the whole-period total as if it were a per-turn mean.
    const avgPerTurn = m.requests > 0 ? Math.round(m.tokens / m.requests) : 0

    return (
      <div className="h-[185px] flex flex-col justify-between pt-1 select-none">
        {/* Model Hero Row */}
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-muted/20 border border-border/40">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] font-mono font-extrabold px-1.5 py-0.5 rounded bg-foreground text-background">
              #1
            </span>
            <span className="font-heading font-extrabold text-sm text-foreground truncate">
              {m.name}
            </span>
            <ProviderBadge
              sources={m.sources}
              className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-card text-muted-foreground border border-border/50 shrink-0"
            />
          </div>
          <span className="text-xs font-bold font-mono px-2 py-0.5 rounded-md bg-primary/10 text-primary shrink-0">
            {t('usage.load100')}
          </span>
        </div>

        {/* 3-Tile Metric Matrix */}
        <div className="grid grid-cols-3 gap-2">
          <div className="p-2 rounded-xl bg-card border border-border/40 space-y-0.5">
            <span className="text-[10px] text-muted-foreground block">{t('usage.callsAndCost')}</span>
            <div className="flex items-baseline gap-1">
              <span className="text-xs font-bold font-mono text-foreground">{t('usage.callCount', { n: m.requests })}</span>
              {m.cost_micros > 0 && (
                <span className="text-[10px] font-mono text-muted-foreground">({fmtCost(m.cost_micros)})</span>
              )}
            </div>
          </div>
          <div className="p-2 rounded-xl bg-card border border-border/40 space-y-0.5">
            <span className="text-[10px] text-muted-foreground block">{t('usage.inOutLabel')}</span>
            <span className="text-xs font-bold font-mono text-foreground block truncate">
              {fmt(m.input_tokens)} / <strong className="text-emerald-600 dark:text-emerald-400">{fmt(m.output_tokens)}</strong>
            </span>
          </div>
          <div className="p-2 rounded-xl bg-card border border-border/40 space-y-0.5">
            <span className="text-[10px] text-muted-foreground block">{t('usage.perTurnAvg')}</span>
            <span className="text-xs font-bold font-mono text-foreground block">
              {m.requests > 0 ? (
                <>{fmt(avgPerTurn)} <span className="text-[9px] font-normal text-muted-foreground">{t('usage.perTurnUnit')}</span></>
              ) : '—'}
            </span>
          </div>
        </div>

        {/* Full-width Workload Bar & Health Status */}
        <div className="space-y-1.5 pt-1 border-t border-border/30">
          <div className="h-1.5 w-full rounded-full bg-foreground" />
          <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>{t('usage.mainModelNote')}</span>
            </span>
            <span className="font-mono text-foreground font-semibold">{fmt(m.tokens)} {t('usage.tokensUnit')}</span>
          </div>
        </div>
      </div>
    )
  }

  // CASE 2: Multi-Model Leaderboard with Macro Spectrum Bar & Scrollable High-Density List
  return (
    <div className="h-[185px] flex flex-col justify-between pt-1 space-y-2 select-none">
      {/* Top Macro Multi-Model Spectrum Bar — 1% floors instead of 3/5%: with
          six small models the clamped widths summed past 100% and the bar
          overflowed its track. */}
      <div className="space-y-1">
        <div className="h-2 w-full rounded-full overflow-hidden bg-muted/60 flex gap-0.5 p-0.5">
          {aggregatedRows.map((m, idx) => {
            const pct = m.share * 100
            const colors = [
              'bg-foreground',
              'bg-emerald-500',
              'bg-sky-500',
              'bg-amber-500',
              'bg-purple-500',
              'bg-muted-foreground',
            ]
            const barColor = colors[idx % colors.length]
            return (
              <div
                key={m.key}
                style={{ width: `${Math.max(1, pct)}%` }}
                className={cn('h-full rounded-full transition-all duration-300', barColor)}
                title={`${m.name}: ${pct.toFixed(1)}% (${fmt(m.tokens)})`}
              />
            )
          })}
        </div>
      </div>

      {/* High-Density Scrollable Model Leaderboard */}
      <div className="flex-1 overflow-y-auto pr-1 space-y-1.5 max-h-[145px]">
        {aggregatedRows.map((m, idx) => {
          const pct = Math.round(m.share * 100)
          return (
            <div
              key={m.key}
              className="flex items-center justify-between p-2 rounded-xl border border-border/40 bg-card/40 hover:bg-card/80 transition-all hover:border-foreground/30 text-xs shadow-2xs"
            >
              {/* Left: Rank + Name + Provider */}
              <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                <span className="text-[10px] font-mono font-bold text-muted-foreground w-4 shrink-0 text-center">
                  #{idx + 1}
                </span>
                <span className="font-bold text-foreground truncate">
                  {m.name}
                </span>
                <ProviderBadge
                  sources={m.sources}
                  className="text-[9.5px] font-medium px-1.5 py-0.2 rounded bg-muted text-muted-foreground border border-border/40 shrink-0 truncate max-w-[140px]"
                />
              </div>

              {/* Right: Calls, Tokens & Share Bar */}
              <div className="flex items-center gap-3 font-mono shrink-0">
                <span className="text-muted-foreground text-[11px] hidden sm:inline">
                  {t('usage.callCount', { n: m.requests })} · {fmt(m.tokens)}
                </span>
                <div className="w-12 h-1.5 rounded-full bg-muted/60 overflow-hidden hidden md:block">
                  <div
                    style={{ width: `${Math.max(2, pct)}%` }}
                    className="h-full bg-foreground rounded-full"
                  />
                </div>
                <span className="text-xs font-bold text-foreground w-9 text-right">
                  {pct}%
                </span>
                {m.cost_micros > 0 && (
                  <span className="text-[10px] text-muted-foreground w-12 text-right">
                    {fmtCost(m.cost_micros)}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Daily Activity Rhythm & Token Throughput Trend Chart (Raycast / Linear Style).
 * Perfectly responsive, 100% fluid container width, zero horizontal scrolling.
 */
function ActivityHeatmap({ daily, days }: { daily: DailyRow[]; days: number }) {
  const { t } = useTranslation()
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const { items, totalActiveDays, totalTokens, peakTokens, avgTokensPerActiveDay } = useMemo(() => {
    const byDate = new Map(daily.map((d) => [d.date, d]))
    const out: {
      date: string
      tokens: number
      turns: number
      cost_micros?: number
      isToday: boolean
      heightPct: number
    }[] = []

    const today = new Date()
    let active = 0
    let totalTok = 0
    let peak = 0

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const row = byDate.get(iso)
      const tokens = row?.tokens ?? 0
      const turns = row?.turns ?? 0
      const cost_micros = row?.cost_micros

      if (tokens > 0) {
        active++
        totalTok += tokens
        if (tokens > peak) peak = tokens
      }

      out.push({
        date: iso,
        tokens,
        turns,
        cost_micros,
        isToday: i === 0,
        heightPct: 0, // Will compute below
      })
    }

    const safePeak = Math.max(peak, 1)
    for (const item of out) {
      if (item.tokens > 0) {
        // Range 15% to 100% height for visibility
        item.heightPct = Math.max(15, Math.round((item.tokens / safePeak) * 100))
      } else {
        item.heightPct = 0
      }
    }

    return {
      items: out,
      totalActiveDays: active,
      totalTokens: totalTok,
      peakTokens: peak,
      avgTokensPerActiveDay: active > 0 ? Math.round(totalTok / active) : 0,
    }
  }, [daily, days])

  const activeHovered = hoveredIdx !== null ? items[hoveredIdx] : null

  return (
    <div className="space-y-4 pt-1">
      {/* Metric Summary Strip */}
      <div className="grid grid-cols-3 gap-2">
        <div className="p-2.5 rounded-xl border border-border/40 bg-muted/20">
          <span className="text-[10px] text-muted-foreground block">{t('usage.activeDaysLabel')}</span>
          <span className="text-xs font-bold font-mono text-foreground mt-0.5 block">
            {totalActiveDays} <span className="text-[10px] font-normal text-muted-foreground">{t('usage.ofDays', { n: days })}</span>
          </span>
        </div>
        <div className="p-2.5 rounded-xl border border-border/40 bg-muted/20">
          <span className="text-[10px] text-muted-foreground block">{t('usage.avgDailyActive')}</span>
          <span className="text-xs font-bold font-mono text-foreground mt-0.5 block">
            {fmt(avgTokensPerActiveDay)} <span className="text-[10px] font-normal text-muted-foreground">{t('usage.tokensUnit')}</span>
          </span>
        </div>
        <div className="p-2.5 rounded-xl border border-border/40 bg-muted/20">
          <span className="text-[10px] text-muted-foreground block">{t('usage.peakDay')}</span>
          <span className="text-xs font-bold font-mono text-foreground mt-0.5 block">
            {fmt(peakTokens)} <span className="text-[10px] font-normal text-muted-foreground">{t('usage.tokensUnit')}</span>
          </span>
        </div>
      </div>

      {/* Responsive Bar Trend Container */}
      <div className="p-4 rounded-2xl bg-muted/20 border border-border/40 space-y-2">
        {/* Dynamic Tooltip Header when hovering */}
        <div className="h-4 flex items-center justify-between text-[11px] font-mono">
          {activeHovered ? (
            <>
              <span className="text-foreground font-semibold flex items-center gap-1.5">
                <span>{activeHovered.date}</span>
                {activeHovered.isToday && (
                  <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-foreground text-background font-bold">
                    {t('usage.today')}
                  </span>
                )}
              </span>
              <span className="text-foreground font-semibold">
                {fmt(activeHovered.tokens)} {t('usage.tokensUnit')} · {t('usage.turnsOf', { n: activeHovered.turns })}
                {activeHovered.cost_micros !== undefined && activeHovered.cost_micros > 0 && (
                  <span className="ml-1 text-muted-foreground font-normal">({fmtCost(activeHovered.cost_micros)})</span>
                )}
              </span>
            </>
          ) : (
            <span className="text-[10.5px] text-muted-foreground">
              {t('usage.hoverDailyHint')}
            </span>
          )}
        </div>

        {/* 100% Fluid Columns Grid */}
        <div className="h-24 w-full flex items-end gap-1 sm:gap-1.5 pt-2">
          {items.map((item, idx) => {
            const hasActivity = item.tokens > 0
            const isHovered = hoveredIdx === idx

            return (
              <div
                key={item.date}
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
                className="flex-1 h-full flex items-end justify-center relative cursor-pointer group"
              >
                <div
                  style={{ height: hasActivity ? `${item.heightPct}%` : '4px' }}
                  className={cn(
                    'w-full rounded-sm transition-all duration-150',
                    hasActivity
                      ? isHovered
                        ? 'bg-foreground ring-2 ring-foreground/30 shadow-xs'
                        : 'bg-foreground/80 group-hover:bg-foreground'
                      : isHovered
                        ? 'bg-muted-foreground/50'
                        : 'bg-muted/60',
                  )}
                />
              </div>
            )
          })}
        </div>

        {/* Time Axis Bounds */}
        <div className="flex items-center justify-between text-[10px] text-muted-foreground/80 font-mono pt-1">
          <span>{items[0]?.date}</span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span>{t('usage.todayWithDate', { d: items[items.length - 1]?.date ?? '' })}</span>
          </span>
        </div>
      </div>
    </div>
  )
}
