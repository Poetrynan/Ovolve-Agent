// src/components/settings/WikiClaims.tsx
// The claim ledger: what the agent believes about this workspace, and the only
// place a human can arbitrate when two beliefs contradict each other.
//
// Why this is NOT a flat list with a "resolve" button:
// `POST /api/wiki/resolve` marks the loser `superseded`. The backend guards the
// one case where that is catastrophic (loserId === winnerId would flip the only
// live claim into superseded and silently lose the fact), but it does NOT check
// that the two claims are actually related — nothing stops arbitrating between
// two unrelated claims and quietly retiring a true one. The pairing information
// lives on the claim itself, in `contradicts[]`, so the UI only offers a verdict
// between a genuinely conflicting pair. That constraint is what dictates the
// whole layout below.
//
// Resolution is irreversible: there is no un-supersede endpoint. Both the
// verdict and the delete therefore go through an AlertDialog that restates the
// text of everything involved — at the moment of choosing you must still be able
// to read what you are choosing between.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Trash2, RefreshCw, Library, Loader2, AlertTriangle, ChevronDown, Check, User, Bot,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { Badge } from '@components/ui/badge'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@components/ui/alert-dialog'
import { fetchJson, sendJson, API_BASE } from '@lib/api'
import { cn } from '@lib/utils'

/** Mirrors `WikiClaim.to_dict()` — which is `asdict()`, so it is snake_case
 *  while the envelope around it is not. Don't "fix" the casing here. */
interface WikiClaim {
  id: string
  root_dir: string
  subject: string
  predicate: string
  object: string
  /** The human-readable sentence. This is the primary thing to render. */
  statement: string
  confidence: number
  evidence: string[]
  /** Ids of claims this one conflicts with — the pairing key for arbitration. */
  contradicts: string[]
  status: 'active' | 'disputed' | 'superseded' | string
  source: string
  created_at: number
  updated_at: number
}

interface ClaimStats {
  active?: number
  disputed?: number
  superseded?: number
  total?: number
}

/** A conflicting pair, deduped so A-vs-B and B-vs-A render once. */
interface Pair { key: string; a: WikiClaim; b: WikiClaim }

/** Two pending confirmations, kept as one nullable so only one can be open. */
type Pending =
  | { kind: 'resolve'; winner: WikiClaim; loser: WikiClaim }
  | { kind: 'delete'; claim: WikiClaim }
  | null

export function WikiClaims() {
  const { t } = useTranslation()
  const [claims, setClaims] = useState<WikiClaim[]>([])
  const [stats, setStats] = useState<ClaimStats>({})
  const [workspace, setWorkspace] = useState('')
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showSuperseded, setShowSuperseded] = useState(false)
  const [pending, setPending] = useState<Pending>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await fetchJson<{ workspace: string; stats: ClaimStats; claims: any[] }>(
        `${API_BASE}/api/wiki/claims?limit=500`,
      )
      // Normalise at the trust boundary: `contradicts` and `evidence` are read
      // with `.length` / `.map` below, and one missing key from an older backend
      // would take the whole card down instead of one row.
      setClaims((d.claims || []).map((c: any) => ({
        ...c,
        id: String(c?.id ?? ''),
        statement: String(c?.statement ?? ''),
        confidence: Number(c?.confidence ?? 0),
        evidence: Array.isArray(c?.evidence) ? c.evidence : [],
        contradicts: Array.isArray(c?.contradicts) ? c.contradicts : [],
        status: String(c?.status ?? 'active'),
        source: String(c?.source ?? ''),
      })))
      setStats(d.stats || {})
      setWorkspace(d.workspace || '')
    } catch (e: any) {
      setError(e?.message || String(e))
      setClaims([])
    } finally {
      setLoading(false)
      setHasLoaded(true)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const resolve = async (winner: WikiClaim, loser: WikiClaim) => {
    setBusyId(loser.id)
    try {
      await sendJson(`${API_BASE}/api/wiki/resolve`, 'POST', {
        winnerId: winner.id, loserId: loser.id,
      })
      await refresh()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (id: string) => {
    setBusyId(id)
    try {
      await sendJson(`${API_BASE}/api/wiki/claims/${encodeURIComponent(id)}`, 'DELETE')
      await refresh()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusyId(null)
    }
  }

  // Skeleton while the claim ledger loads. Mirrors the real sections
  // (header + 3 claim rows) so the swap is a same-height replacement. The
  // Card stays mounted throughout, so there is no wrapper-height jump either.
  if (loading && !hasLoaded) {
    return (
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="min-w-0 space-y-2">
            <div className="h-5 w-32 rounded bg-muted/60" />
            <div className="h-3 w-48 rounded bg-muted/40" />
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-start gap-3 rounded-lg border border-border/30 p-3">
              <div className="h-4 w-4 rounded bg-muted/40 shrink-0 mt-0.5" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-full rounded bg-muted/40" />
                <div className="h-2.5 w-2/3 rounded bg-muted/30" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    )
  }

  const byId = new Map(claims.map((c) => [c.id, c]))
  const disputed = claims.filter((c) => c.status === 'disputed')
  const active = claims.filter((c) => c.status === 'active')
  const superseded = claims.filter((c) => c.status === 'superseded')

  // Pair up conflicts. A disputed claim whose counterpart is missing (deleted,
  // or outside the fetched window) is kept and rendered WITHOUT a verdict
  // button — offering one would mean arbitrating against nothing.
  const pairs: Pair[] = []
  const seen = new Set<string>()
  const orphans: WikiClaim[] = []
  for (const c of disputed) {
    const partners = c.contradicts.map((id) => byId.get(id)).filter(Boolean) as WikiClaim[]
    if (partners.length === 0) { orphans.push(c); continue }
    for (const p of partners) {
      const key = [c.id, p.id].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({ key, a: c, b: p })
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="min-w-0">
          <CardTitle className="text-base flex items-center gap-2">
            <Library size={16} className="text-muted-foreground" />
            {t('wikiClaims.title')}
            {(stats.disputed ?? 0) > 0 && (
              <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning h-5">
                {t('wikiClaims.disputedBadge', { count: stats.disputed })}
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="text-[11px] max-w-[420px]">
            {t('wikiClaims.hint')}
          </CardDescription>
        </div>
        <Button
          size="sm" variant="ghost"
          onClick={refresh}
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
          className="h-7 px-2 shrink-0 active:transform-none"
        >
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
        </Button>
      </CardHeader>

      <CardContent className="space-y-3">
        {workspace && (
          <p className="text-[10px] text-muted-foreground/70 font-mono truncate" title={workspace}>
            {workspace}
          </p>
        )}

        {error && (
          <p className="text-[11px] text-destructive">{error}</p>
        )}

        {/* ── Conflicts first: this is the only part that needs a decision ── */}
        {pairs.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-warning flex items-center gap-1.5">
              <AlertTriangle size={11} />
              {t('wikiClaims.conflictsHeading', { count: pairs.length })}
            </h4>
            {pairs.map(({ key, a, b }) => (
              <div key={key} className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 space-y-2">
                <p className="text-[10px] text-muted-foreground">
                  {t('wikiClaims.pickOne')}
                </p>
                {[a, b].map((c, i) => (
                  <ClaimRow
                    key={c.id}
                    claim={c}
                    busy={busyId === c.id}
                    t={t}
                    action={
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px] gap-1 shrink-0"
                        disabled={busyId !== null}
                        onClick={() => setPending({
                          kind: 'resolve', winner: c, loser: i === 0 ? b : a,
                        })}
                      >
                        <Check size={11} />
                        {t('wikiClaims.keepThis')}
                      </Button>
                    }
                  />
                ))}
              </div>
            ))}
          </section>
        )}

        {/* Disputed but unpairable — reported rather than hidden, because a
            claim stuck in `disputed` forever is a real state the user should
            be able to see and delete. */}
        {orphans.length > 0 && (
          <section className="space-y-1.5">
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('wikiClaims.orphanHeading')}
            </h4>
            <p className="text-[10px] text-muted-foreground/70">{t('wikiClaims.orphanHint')}</p>
            {orphans.map((c) => (
              <ClaimRow
                key={c.id} claim={c} busy={busyId === c.id} t={t}
                action={<DeleteButton onClick={() => setPending({ kind: 'delete', claim: c })} disabled={busyId !== null} t={t} />}
              />
            ))}
          </section>
        )}

        {/* ── Settled beliefs ── */}
        <section className="space-y-1.5">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('wikiClaims.activeHeading', { count: active.length })}
          </h4>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {active.map((c) => (
              <ClaimRow
                key={c.id} claim={c} busy={busyId === c.id} t={t}
                action={<DeleteButton onClick={() => setPending({ kind: 'delete', claim: c })} disabled={busyId !== null} t={t} />}
              />
            ))}
            {active.length === 0 && hasLoaded && (
              <p className="text-xs text-muted-foreground py-3 text-center">
                {t('wikiClaims.empty')}
              </p>
            )}
          </div>
        </section>

        {/* ── History. Collapsed: superseded claims are a record, not a task ── */}
        {superseded.length > 0 && (
          <section>
            <button
              type="button"
              onClick={() => setShowSuperseded((v) => !v)}
              aria-expanded={showSuperseded}
              className="w-full flex items-center gap-1.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
            >
              <span className="flex-1 text-left">
                {t('wikiClaims.supersededHeading', { count: superseded.length })}
              </span>
              <ChevronDown
                size={12}
                className={cn('transition-transform duration-200', showSuperseded && 'rotate-180')}
              />
            </button>
            {showSuperseded && (
              <div className="space-y-1.5 pt-1">
                {superseded.map((c) => (
                  <ClaimRow
                    key={c.id} claim={c} busy={busyId === c.id} t={t} dimmed
                    action={<DeleteButton onClick={() => setPending({ kind: 'delete', claim: c })} disabled={busyId !== null} t={t} />}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </CardContent>

      {/* One dialog serves both irreversible actions. It always restates the
          full text involved — a confirmation that only says "are you sure?"
          forces the user to decide from memory. */}
      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o) setPending(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === 'resolve'
                ? t('wikiClaims.confirmResolveTitle')
                : t('wikiClaims.confirmDeleteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'resolve'
                ? t('wikiClaims.confirmResolveBody')
                : t('wikiClaims.confirmDeleteBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {pending?.kind === 'resolve' && (
            <div className="space-y-2 text-xs">
              <div className="rounded-lg border border-success/30 bg-success/5 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-success mb-1">
                  {t('wikiClaims.keeping')}
                </p>
                <p className="leading-relaxed">{pending.winner.statement}</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-muted/40 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  {t('wikiClaims.retiring')}
                </p>
                <p className="leading-relaxed text-muted-foreground">{pending.loser.statement}</p>
              </div>
            </div>
          )}
          {pending?.kind === 'delete' && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
              <p className="leading-relaxed">{pending.claim.statement}</p>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!pending) return
                if (pending.kind === 'resolve') void resolve(pending.winner, pending.loser)
                else void remove(pending.claim.id)
                setPending(null)
              }}
            >
              {pending?.kind === 'resolve'
                ? t('wikiClaims.confirmResolveAction')
                : t('wikiClaims.confirmDeleteAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function DeleteButton({ onClick, disabled, t }: {
  onClick: () => void; disabled: boolean; t: (k: string) => string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 p-1 rounded text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
      aria-label={t('wikiClaims.delete')}
      title={t('wikiClaims.delete')}
    >
      <Trash2 size={12} />
    </button>
  )
}

/**
 * One claim.
 *
 * `statement` is the body because that is the sentence a human reads. The
 * subject/predicate/object triple is what the machine matches on — kept, but
 * demoted to a monospace footnote. Confidence is a bar rather than a number:
 * the useful read is "how sure, roughly", and 0.82 invites false precision on a
 * value the backend derives heuristically.
 */
function ClaimRow({ claim, busy, action, dimmed, t }: {
  claim: WikiClaim
  busy: boolean
  action: React.ReactNode
  dimmed?: boolean
  t: (k: string, o?: any) => string
}) {
  const [showEvidence, setShowEvidence] = useState(false)
  const fromUser = claim.source === 'user'

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border border-border/40 px-2.5 py-2 bg-background/40',
        dimmed && 'opacity-60',
      )}
    >
      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-xs leading-relaxed break-words">{claim.statement}</p>

        <div className="flex items-center gap-2 flex-wrap text-[9px] text-muted-foreground/70">
          {/* A claim the user asserted is not the same kind of thing as one the
              model inferred, so the origin gets an icon rather than a word. */}
          <span className="flex items-center gap-1" title={claim.source}>
            {fromUser ? <User size={9} /> : <Bot size={9} />}
            {fromUser ? t('wikiClaims.sourceUser') : t('wikiClaims.sourceAgent')}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-10 h-1 rounded-full bg-foreground/10 overflow-hidden">
              <span
                className="block h-full rounded-full bg-foreground/40"
                style={{ width: `${Math.round(Math.min(1, Math.max(0, claim.confidence)) * 100)}%` }}
              />
            </span>
            {t('wikiClaims.confidence')}
          </span>
          {claim.evidence.length > 0 && (
            <button
              type="button"
              onClick={() => setShowEvidence((v) => !v)}
              aria-expanded={showEvidence}
              className="underline decoration-dotted hover:text-foreground transition-colors"
            >
              {t('wikiClaims.evidence', { count: claim.evidence.length })}
            </button>
          )}
        </div>

        <p className="font-mono text-[9px] text-muted-foreground/50 truncate">
          {claim.subject} · {claim.predicate} · {claim.object}
        </p>

        {showEvidence && (
          <ul className="space-y-0.5 pt-0.5">
            {claim.evidence.map((e, i) => (
              <li key={i} className="text-[10px] text-muted-foreground/80 break-words">— {e}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-1">
        {busy ? <Loader2 size={12} className="animate-spin text-muted-foreground" /> : action}
      </div>
    </div>
  )
}
