// src/components/settings/MemoryDiagnostics.tsx
// Tier occupancy (what is stored) + retrieval health (how it reaches the
// prompt). One component, two views, because both read the same
// `/api/memory/diagnostics` payload — splitting the file would mean two
// fetches of the identical response.
//
// `view` decides which half renders:
//   'memory'  → tier occupancy + per-entry editing  (Settings → 记忆)
//   'context' → retrieval channels, cache/breaker, recall paths (→ 上下文)
//
// Claim adjudication used to live here too; it now belongs to WikiClaims,
// which is the only place a contradiction gets settled and has the
// confirm-before-supersede flow that irreversible verdict needs.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Database, Gauge, RefreshCw, Trash2,
  ShieldCheck, Zap, Timer, Layers,
  ChevronRight, Plus, Pencil, Check, X, Search, Loader2, Lock,
} from 'lucide-react'
import { API_BASE, fetchJson, sendJson } from '@lib/api'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@components/ui/dialog'
import { cn } from '@/lib/utils'
// 同一个接口只该有一个形状。这里以前自己抄了一份 MemoryEntry，于是 0013 加的
// status/confidence 只会被其中一份学到——两份声明就是两个事实来源。
import type { MemoryEntry } from '@components/settings/MemorySettings'

interface TierStat {

  tier: string
  count: number
  tokens: number
  expired: number
  overBudget: boolean
  tokenBudget: number
  ttlSeconds: number
  alwaysInject: boolean
  userEditable: boolean
  trust: string
  persisted: boolean
}
interface FtsStats { enabled: boolean; indexed: number }
interface BreakerState {
  state: 'closed' | 'open' | 'half_open'
  failures: number
  total_opens: number
  cooldown_seconds: number
  failure_threshold: number
}
interface CacheStats {
  size: number; max_size: number; ttl_seconds: number
  hits: number; misses: number; hit_rate: number
}
interface ActiveSnapshot {
  stats: Record<string, number>
  cache: CacheStats
  breaker: BreakerState
  timeout_seconds: number
}
interface RetrievalChannels {
  root: string
  rows: number
  embedded: number
  coverage: number
  vectorUsable: boolean
  embedderWired: boolean
  mode: 'hybrid' | 'keyword_only'
  nominalVectorWeight: number
  nominalKeywordWeight: number
  effectiveVectorWeight: number
  effectiveKeywordWeight: number
  degraded: boolean
  pendingEmbeddings: number
}
interface Diagnostics {
  workspace: string
  tiers: TierStat[]
  fts: FtsStats
  active: ActiveSnapshot | null
  wikiStats: Record<string, number>
  retrieval?: RetrievalChannels | null
}


function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

function relTime(ts: number, t: (k: string, o?: any) => string): string {
  if (!ts) return '—'
  const diff = Math.max(0, Date.now() / 1000 - ts)
  if (diff < 60) return t('memory.justNow')
  if (diff < 3600) return t('memory.minutesAgo', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('memory.hoursAgo', { n: Math.floor(diff / 3600) })
  return t('memory.daysAgo', { n: Math.floor(diff / 86400) })
}

/** Backend tier ids are enum values (`short-term-recall`), not display text.
 *  Falls back to the raw id so a newly added tier shows up as itself rather
 *  than blank — a missing tier reads as "broken", the raw id reads as "new". */
function tierLabel(tier: string, t: (k: string, o?: any) => string): string {
  const key = `memory.tier.${tier}`
  const label = t(key)
  return label === key ? tier : label
}

export function MemoryDiagnostics({ view }: { view: 'memory' | 'context' }) {
  const { t } = useTranslation()
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setDiag(await fetchJson<Diagnostics>(`${API_BASE}/api/memory/diagnostics`))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const act = async (label: string, fn: () => Promise<any>) => {
    setBusy(label)
    try { await fn(); await load() } catch (e) { setError(String(e)) } finally { setBusy(null) }
  }

  const reindex = () => act('reindex', () => sendJson(`${API_BASE}/api/memory/reindex`, 'POST'))
  const backfill = () => act('backfill', () => sendJson(`${API_BASE}/api/memory/backfill`, 'POST'))
  const clearCache = () => act('cache', () => sendJson(`${API_BASE}/api/memory/cache/clear`, 'POST'))

  if (loading && !diag) {
    // Skeleton shaped like the settled layout of *this* view so data arriving
    // is a same-height swap rather than the panel popping in.
    return (
      <div className="space-y-4">
        {view === 'context' ? (
          <div className="rounded-xl border border-border/40 bg-card/60 p-4 space-y-3">
            <div className="h-4 w-40 rounded bg-muted/50" />
            <div className="h-2.5 w-full rounded bg-muted/30" />
            <div className="grid grid-cols-4 gap-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded bg-muted/30" />
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-border/40 bg-card/60 p-4 space-y-2">
            <div className="h-4 w-32 rounded bg-muted/50 mb-3" />
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 rounded bg-muted/30" />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t('memory.loadError')}: {error}
        </div>
      )}
      {view === 'context' && diag?.active && (
        <RetrievalHealth
          snap={diag.active} fts={diag.fts} channels={diag.retrieval ?? null}
          onReindex={reindex} onClearCache={clearCache} onBackfill={backfill}
          onRefresh={load} busy={busy}
        />
      )}
      {view === 'memory' && diag && <TierPanel tiers={diag.tiers} onMutate={load} />}
    </div>
  )
}

/* ─── Retrieval health (C2 FTS + C3 cache/breaker) ─────────────────── */

/* The breaker used to render through <Metric>, which meant the *healthy* state
 * shouted a big green 闭合 — the loudest thing in the row was also the least
 * actionable, and "闭合" only parses if you already know what a circuit breaker
 * is. Now the state is a dot beside the label and the body says, in plain
 * words, what is actually happening. Colour carries urgency, not size. */
const BREAKER_STYLE: Record<string, { dot: string; pill: string; key: string; desc: string }> = {
  closed: {
    dot: 'bg-success', pill: 'text-success bg-success/10',
    key: 'memory.breakerClosed', desc: 'memory.breakerDescClosed',
  },
  half_open: {
    dot: 'bg-warning', pill: 'text-warning bg-warning/10',
    key: 'memory.breakerHalfOpen', desc: 'memory.breakerDescHalfOpen',
  },
  open: {
    dot: 'bg-destructive', pill: 'text-destructive bg-destructive/10',
    key: 'memory.breakerOpen', desc: 'memory.breakerDescOpen',
  },
}

function BreakerCard({ breaker }: { breaker: BreakerState }) {
  const { t } = useTranslation()
  const bs = BREAKER_STYLE[breaker.state] || BREAKER_STYLE.closed
  return (
    <div className="rounded-lg border border-border/30 bg-background/40 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1.5">
        <ShieldCheck size={12} className="shrink-0" />
        <span className="truncate cursor-help" title={t('memory.breakerWhat')}>
          {t('memory.breaker')}
        </span>
        <span
          className={cn(
            'ml-auto shrink-0 inline-flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-full text-[10px] font-medium',
            bs.pill,
          )}
        >
          <span className={cn('w-1.5 h-1.5 rounded-full', bs.dot)} />
          {t(bs.key)}
        </span>
      </div>
      <p className="text-[11px] leading-snug text-foreground/70">{t(bs.desc)}</p>
      <div className="text-[10px] text-muted-foreground mt-1">
        {t('memory.breakerOpens', { n: breaker.total_opens })}
      </div>
    </div>
  )
}

function RetrievalHealth({
  snap, fts, channels, onReindex, onClearCache, onBackfill, onRefresh, busy,
}: {
  snap: ActiveSnapshot; fts: FtsStats; channels: RetrievalChannels | null
  onReindex: () => void; onClearCache: () => void; onBackfill: () => void
  onRefresh: () => void
  busy: string | null
}) {
  const { t } = useTranslation()
  const s = snap.stats
  return (
    <div className="rounded-xl border border-border/40 bg-card/60 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium flex items-center gap-1.5">
          <Gauge size={14} className="text-muted-foreground" />
          {t('memory.retrieval')}
        </h3>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onClearCache}
            disabled={!!busy}
            className="px-2 py-1 rounded text-[11px] bg-muted/40 hover:bg-muted/70 transition-colors disabled:opacity-40"
          >
            {t('memory.clearCache')}
          </button>
          <button
            onClick={onReindex}
            disabled={!!busy}
            className="px-2 py-1 rounded text-[11px] bg-muted/40 hover:bg-muted/70 transition-colors disabled:opacity-40"
          >
            {t('memory.reindex')}
          </button>
          <button
            onClick={onRefresh}
            disabled={!!busy}
            aria-label={t('common.refresh')}
            title={t('common.refresh')}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={12} className={cn(busy && 'animate-spin')} />
          </button>
        </div>
      </div>

      {channels && (
        <ChannelDeclaration
          channels={channels} onBackfill={onBackfill} busy={busy}
        />
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Metric icon={Zap} label={t('memory.cacheHitRate')}
                value={`${Math.round(snap.cache.hit_rate * 100)}%`}
                sub={`${snap.cache.hits}/${snap.cache.hits + snap.cache.misses}`} />
        <Metric icon={Database} label={t('memory.ftsIndexed')}
                value={fts.enabled ? fmt(fts.indexed) : '—'}
                sub={fts.enabled ? t('memory.ftsOn') : t('memory.ftsOff')} />
        <Metric icon={Timer} label={t('memory.timeouts')}
                value={String(s.timeouts ?? 0)}
                sub={t('memory.timeoutBudget', { n: snap.timeout_seconds })} />
        <BreakerCard breaker={snap.breaker} />
      </div>

      <PathBars stats={s} />
    </div>
  )
}

/* Which retrieval channels are ACTUALLY live, versus what the 0.7/0.3 config
 * implies. The panel used to show cache and FTS numbers while staying silent on
 * whether the vector channel had ever scored a document — so a workspace with
 * zero embeddings looked like healthy hybrid search. This states the mode
 * plainly and, when degraded, offers the one-click backfill that fixes it. */
function ChannelDeclaration({
  channels, onBackfill, busy,
}: { channels: RetrievalChannels; onBackfill: () => void; busy: string | null }) {
  const { t } = useTranslation()
  const degraded = channels.degraded
  const hint = !channels.embedderWired
    ? t('memory.channelsHintNoEmbedder')
    : degraded
      ? t('memory.channelsHintDegraded')
      : t('memory.channelsHintHybrid')
  const pending = channels.pendingEmbeddings
  return (
    <div
      className={cn(
        'rounded-lg border p-3 mb-4',
        degraded
          ? 'border-warning/40 bg-warning/5'
          : 'border-border/30 bg-background/40',
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] mb-1.5">
        <Layers size={12} className={degraded ? 'text-warning' : 'text-muted-foreground'} />
        <span className="text-muted-foreground">{t('memory.channels')}</span>
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-full text-[10px] font-medium',
            degraded ? 'text-warning bg-warning/10' : 'text-success bg-success/10',
          )}
        >
          <span className={cn('w-1.5 h-1.5 rounded-full', degraded ? 'bg-warning' : 'bg-success')} />
          {degraded ? t('memory.channelsKeywordOnly') : t('memory.channelsHybrid')}
        </span>
      </div>
      <p className="text-[11px] leading-snug text-foreground/70">{hint}</p>
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        <span className="text-[10px] text-muted-foreground font-mono">
          {t('memory.channelsWeights', {
            v: channels.effectiveVectorWeight,
            k: channels.effectiveKeywordWeight,
          })}
        </span>
        <span className="text-[10px] text-muted-foreground font-mono">
          {t('memory.embeddingCoverage')}: {Math.round(channels.coverage * 100)}%
          {' '}
          <span className="text-muted-foreground/70">
            ({t('memory.embeddingCoverageSub', {
              done: channels.embedded, total: channels.rows,
            })})
          </span>
        </span>
        {channels.embedderWired && pending > 0 && (
          <button
            onClick={onBackfill}
            disabled={!!busy}
            className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-warning/15 text-warning hover:bg-warning/25 transition-colors disabled:opacity-40"
          >
            {busy === 'backfill'
              ? <Loader2 size={11} className="animate-spin" />
              : <Zap size={11} />}
            {t('memory.backfill')}
            <span className="font-mono opacity-70">
              ({t('memory.backfillPending', { n: pending })})
            </span>
          </button>
        )}
      </div>
    </div>
  )
}

function Metric({
  icon: Icon, label, value, sub, valueCls,
}: { icon: any; label: string; value: string; sub?: string; valueCls?: string }) {
  return (
    <div className="rounded-lg border border-border/30 bg-background/40 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
        <Icon size={12} />
        {label}
      </div>
      <div className={cn('text-lg font-heading font-bold tracking-tight inline-block px-1 rounded', valueCls)}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  )
}

function PathBars({ stats }: { stats: Record<string, number> }) {
  const { t } = useTranslation()
  const parts = [
    { key: 'served', label: t('memory.pathLive'), cls: 'bg-foreground/70' },
    { key: 'cache_hits', label: t('memory.pathCache'), cls: 'bg-success' },
    { key: 'empty', label: t('memory.pathEmpty'), cls: 'bg-muted-foreground/50' },
    { key: 'timeouts', label: t('memory.pathTimeout'), cls: 'bg-warning' },
    { key: 'breaker_shortcircuits', label: t('memory.pathBreaker'), cls: 'bg-destructive' },
    { key: 'errors', label: t('memory.pathError'), cls: 'bg-destructive/60' },
  ]
  const total = parts.reduce((a, p) => a + (stats[p.key] ?? 0), 0)
  if (!total) return <div className="text-[11px] text-muted-foreground">{t('memory.noRecallsYet')}</div>
  return (
    <div>
      <div className="flex h-2 rounded-full overflow-hidden mb-2">
        {parts.map((p) => {
          const v = stats[p.key] ?? 0
          return v ? <div key={p.key} className={p.cls} style={{ width: `${(v / total) * 100}%` }} /> : null
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => {
          const v = stats[p.key] ?? 0
          if (!v) return null
          return (
            <li key={p.key} className="flex items-center gap-1.5 text-[11px]">
              <span className={cn('w-2 h-2 rounded-sm', p.cls)} />
              <span className="text-muted-foreground">{p.label}</span>
              <span className="font-mono">{v}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* ─── Tier occupancy (C1) + entry-level editing ─────────────────────
 *
 * The row used to be pure readout: count + token budget. That left the user
 * able to see that memory existed but not what it said — and LONG_TERM is
 * injected into every prompt, so one wrong line there poisons every future
 * turn with no way to reach in and fix it. Opening a row loads the actual
 * entries and makes them editable.
 *
 * Entries live in a MODAL, not an inline accordion. Inline expansion pushed
 * every panel below the tier list down by however many entries the tier held —
 * with a few hundred long-term memories the settings page became unscrollable
 * in practice, and the tier you were reading drifted off screen while you
 * edited. A dialog gives the list its own bounded, scrollable viewport and
 * leaves the page geometry alone.
 *
 * Entries load lazily, on first open. Six tiers × a full content fetch on
 * mount would make opening the settings page pay for data most visits never
 * look at.
 */

function TierPanel({ tiers, onMutate }: { tiers: TierStat[]; onMutate: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<string | null>(null)
  // Which tier the dialog is SHOWING — deliberately not the same thing as which
  // one is open. Radix keeps DialogContent mounted while the close animation
  // plays, so a body derived from `open` empties itself the instant you click ✕:
  // the title, the counters and the entry list all vanish in one frame and you
  // then watch an empty box shrink. Holding the last opened tier keeps the
  // content on screen for the whole exit, so closing looks like one movement.
  const shownRef = useRef<string | null>(null)
  if (open) shownRef.current = open
  const shown = open ?? shownRef.current
  if (!tiers.length) return null
  const openTier = tiers.find((x) => x.tier === shown) || null
  return (
    <div className="rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md shadow-xs overflow-hidden divide-y divide-border/30">
      <div className="p-4 sm:p-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 text-muted-foreground border border-border/40">
            <Layers className="w-3.5 h-3.5" />
          </div>
          <div>
            <h3 className="text-sm sm:text-base font-bold text-foreground tracking-tight flex items-center gap-2">
              {t('memory.tiers')}
              <span className="px-2 py-0.5 rounded-full text-[10px] font-normal text-muted-foreground bg-muted border border-border/40">
                {t('memory.tiersScope')}
              </span>
            </h3>
          </div>
        </div>
      </div>

      <div className="p-4 sm:p-5 space-y-2">
        {tiers.map((tr) => {
          const pct = tr.tokenBudget > 0 ? Math.min(100, (tr.tokens / tr.tokenBudget) * 100) : 0
          const expandable = tr.tier !== 'wiki'
          return (
            <div key={tr.tier} className="rounded-xl border border-border/30 bg-background/40 hover:bg-background/80 hover:border-border/50 transition-all p-2.5 shadow-2xs">
              <button
                type="button"
                disabled={!expandable}
                onClick={() => setOpen(tr.tier)}
                className={cn(
                  'w-full text-left active:transform-none',
                  expandable ? 'cursor-pointer' : 'cursor-default',
                )}
              >
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {expandable ? (
                      <ChevronRight size={12} className="shrink-0 text-muted-foreground" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className="font-semibold text-foreground truncate">{tierLabel(tr.tier, t)}</span>
                    {tr.alwaysInject && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded-md text-[9px] font-medium bg-foreground/10 text-muted-foreground border border-border/30">
                        {t('memory.alwaysInject')}
                      </span>
                    )}
                    {tr.overBudget && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded-md text-[9px] font-medium bg-warning/20 text-warning border border-warning/30">
                        {t('memory.overBudget')}
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground shrink-0 ml-2 font-mono text-[11px]" title={t('memory.tokenEstimateTitle')}>
                    {t('memory.tierCount', { n: tr.count })} · ≈{fmt(tr.tokens)}
                    {tr.tokenBudget > 0 ? `/${fmt(tr.tokenBudget)}` : ''} {t('memory.tokenUnit')}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-muted/60 overflow-hidden">
                  <div
                    className={cn('h-full rounded-full transition-all duration-500', tr.overBudget ? 'bg-warning' : 'bg-foreground/70')}
                    style={{ width: `${Math.max(tr.count ? 2 : 0, pct)}%` }}
                  />
                </div>
              </button>
            </div>
          )
        })}
      </div>

      {/* One dialog for all tiers */}
      <Dialog open={!!open} onOpenChange={(v) => { if (!v) setOpen(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-1.5">
              <Layers size={14} className="text-muted-foreground" />
              {openTier ? tierLabel(openTier.tier, t) : ''}
              {openTier?.alwaysInject && (
                <span className="px-1 rounded text-[9px] font-normal bg-foreground/10 text-muted-foreground">
                  {t('memory.alwaysInject')}
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="text-[11px] font-mono" title={t('memory.tokenEstimateTitle')}>
              {openTier && (
                <>
                  {t('memory.tierCount', { n: openTier.count })} · ≈{fmt(openTier.tokens)}
                  {openTier.tokenBudget > 0 ? `/${fmt(openTier.tokenBudget)}` : ''} {t('memory.tokenUnit')}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {/* Bounded viewport: the whole point of moving this out of the page.
              `-mx-2 px-2` is not cosmetic — this box is `overflow-y-auto`, and
              CSS forces the cross axis to `auto` too, so it clips horizontally.
              With zero side padding the search field's rounded border and focus
              ring sat exactly on that clip line and lost their left edge. The
              negative-margin/padding pair keeps the visible width identical
              while giving the clip 8px of breathing room. */}
          <div className="max-h-[60vh] overflow-y-auto -mx-2 px-2">
            {shown && <EntryEditor tier={shown} onMutate={onMutate} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ─── Entry editor: the actual content of one tier ──────────────────
 *
 * `onMutate` bubbles up so the tier bar above re-reads its count/token totals
 * after an edit. Without it the header would keep showing the pre-edit numbers
 * and the panel would look like the write silently failed.
 */

function EntryEditor({ tier, onMutate }: { tier: string; onMutate: () => void }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<MemoryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [newText, setNewText] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async (q: string) => {
    setLoading(true)
    setErr(null)
    try {
      const url = `${API_BASE}/api/memory/entries?tier=${encodeURIComponent(tier)}`
        + `&limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`
      const d = await fetchJson(url)
      setRows(d.entries || [])
      setTotal(d.total || 0)
    } catch (e: any) {
      setErr(e?.message || String(e))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [tier])

  useEffect(() => { void load(query) }, [load, query])

  // Debounce-free on purpose: the list is capped at 200 rows and the filter runs
  // server-side over an already-in-memory table, so a keystroke-per-fetch is
  // cheaper than the complexity of a debounce here.
  const save = async (id: string) => {
    const text = draft.trim()
    if (!text) return
    setBusyId(id)
    try {
      await sendJson(`${API_BASE}/api/memory/entries/${encodeURIComponent(id)}`, 'PATCH',
        { content: text })
      setEditingId(null)
      await load(query)
      onMutate()
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (id: string) => {
    setBusyId(id)
    try {
      await sendJson(`${API_BASE}/api/memory/entries/${encodeURIComponent(id)}`, 'DELETE')
      await load(query)
      onMutate()
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusyId(null)
    }
  }

  const create = async () => {
    const text = newText.trim()
    if (!text) return
    setBusyId('__new__')
    try {
      await sendJson(`${API_BASE}/api/memory/entries`, 'POST', { content: text, tier })
      setNewText('')
      setAdding(false)
      await load(query)
      onMutate()
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusyId(null)
    }
  }

  const canAdd = rows.every((r) => r.editable) || rows.length === 0

  // Skeleton while the tier's entries load. Without it the dialog renders an
  // empty list for one frame and then the rows pop in — a twitch every time a
  // tier is opened. The skeleton's rows mirror the settled list's height.
  if (loading) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <div className="h-7 flex-1 rounded-md bg-muted/30" />
          <div className="h-7 w-20 rounded-md bg-muted/30" />
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg border border-border/20 p-2.5">
            <div className="h-4 w-4 rounded bg-muted/30 shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-full rounded bg-muted/30" />
              <div className="h-2.5 w-2/3 rounded bg-muted/20" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Search + add */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('memory.entrySearch')}
            className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-background/85 dark:bg-white/5 border border-border/70 dark:border-white/10 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40 shadow-2xs text-foreground placeholder:text-muted-foreground/60"
          />
        </div>
        {canAdd && (
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-2xs transition-all cursor-pointer active:scale-95"
          >
            <Plus size={13} />
            <span>{t('memory.entryNew')}</span>
          </button>
        )}
      </div>

      {adding && (
        <div className="flex items-start gap-1.5">
          <textarea
            autoFocus
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void create() }
              else if (e.key === 'Escape') { setAdding(false); setNewText('') }
            }}
            rows={2}
            placeholder={t('memory.entryNewPlaceholder')}
            className="flex-1 min-w-0 px-2 py-1.5 rounded-md bg-background/70 border border-border/50 text-[11px] resize-y focus:outline-none focus:ring-1 focus:ring-ring/30"
          />
          <button
            type="button"
            onClick={create}
            disabled={!newText.trim() || busyId === '__new__'}
            className="shrink-0 p-1 rounded text-success hover:bg-success/10 disabled:opacity-40"
            aria-label={t('memory.entrySave')}
          >
            {busyId === '__new__' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          </button>
          <button
            type="button"
            onClick={() => { setAdding(false); setNewText('') }}
            className="shrink-0 p-1 rounded text-muted-foreground hover:bg-foreground/10"
            aria-label={t('memory.entryCancel')}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {err && <p className="text-[11px] text-destructive">{err}</p>}

      {loading ? (
        <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 py-1">
          <Loader2 size={11} className="animate-spin" />
          {t('memory.entryLoading')}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground py-1">
          {query ? t('memory.entryNoMatch') : t('memory.entryEmpty')}
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.id} className="group rounded-xl bg-background/80 dark:bg-white/5 border border-border/70 dark:border-white/10 px-3 py-2.5 shadow-2xs transition-all hover:border-border">
                {editingId === row.id ? (
                  <div className="flex items-start gap-1.5">
                    <textarea
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(row.id) }
                        else if (e.key === 'Escape') setEditingId(null)
                      }}
                      rows={3}
                      className="flex-1 min-w-0 px-2 py-1 rounded bg-background border border-border/60 text-[11px] leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-ring/30"
                    />
                    <button
                      type="button"
                      onClick={() => save(row.id)}
                      disabled={!draft.trim() || busyId === row.id}
                      className="shrink-0 p-1 rounded text-success hover:bg-success/10 disabled:opacity-40"
                      aria-label={t('memory.entrySave')}
                    >
                      {busyId === row.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="shrink-0 p-1 rounded text-muted-foreground hover:bg-foreground/10"
                      aria-label={t('memory.entryCancel')}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <p className="flex-1 min-w-0 text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                      {row.content}
                    </p>
                    <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      {row.editable ? (
                        <>
                          <button
                            type="button"
                            onClick={() => { setEditingId(row.id); setDraft(row.content) }}
                            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/10"
                            aria-label={t('memory.entryEdit')}
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            type="button"
                            onClick={() => remove(row.id)}
                            disabled={busyId === row.id}
                            className="p-1 rounded text-destructive hover:bg-destructive/10 disabled:opacity-40"
                            aria-label={t('memory.entryDelete')}
                          >
                            {busyId === row.id
                              ? <Loader2 size={11} className="animate-spin" />
                              : <Trash2 size={11} />}
                          </button>
                        </>
                      ) : (
                        <span
                          className="p-1 text-muted-foreground/60"
                          title={t('memory.entryReadOnly')}
                        >
                          <Lock size={11} />
                        </span>
                      )}
                    </div>
                  </div>
                )}
                <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground/70 font-mono">
                  <span title={t('memory.tokenEstimateTitle')}>≈{fmt(row.tokens)} {t('memory.tokenUnit')}</span>
                  {row.hits > 0 && <span>· {t('memory.entryHits', { n: row.hits })}</span>}
                  <span>· {relTime(row.updatedAt || row.createdAt, t)}</span>
                </div>
              </li>
            ))}
          </ul>
          {total > rows.length && (
            <p className="text-[10px] text-muted-foreground/70">
              {t('memory.entryTruncated', { shown: rows.length, total })}
            </p>
          )}
        </>
      )}
    </div>
  )
}
