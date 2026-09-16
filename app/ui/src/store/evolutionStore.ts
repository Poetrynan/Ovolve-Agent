/**
 * evolutionStore — self-improvement proposals awaiting the user's verdict.
 *
 * Source of truth is `app/backend/evolution.py` (its own SQLite at
 * ~/.ovolve/db/evolution.db), surfaced through `/api/evolution/*`.
 *
 * Why this needs a UI at all: accepting a proposal APPENDS A RULE TO AGENTS.md
 * or MEMORY.md on disk, permanently, and `decide()` is the only code path that
 * writes. Nothing is auto-applied — `cautious` and `active` differ only in how
 * many repeats count as "sure enough", never in whether consent is required.
 * So without this page the whole subsystem is inert: mode defaults to `off`, and
 * even when switched on, proposals pile up invisibly until `max_open` (2 or 5)
 * is reached, at which point mining silently stops for good.
 *
 * Not persisted: proposals are backend state, and a stale localStorage copy
 * claiming a rule is pending would be worse than one fetch.
 */
import { create } from 'zustand'
import { fetchJson, sendJson, API_BASE } from '@lib/api'

/** `off` short-circuits everything; the other two only shift the thresholds. */
export type EvolutionMode = 'off' | 'cautious' | 'active'

/** Only `tool_failure` and `tool_denied` have producers today; the other two
 *  are mapped in the backend's KIND_TARGET but nothing emits them yet.
 *  `learned_fact` / `fact_conflict` / `extracted_context` come from the
 *  observation layer — `fact_conflict` means the draft REPLACES an existing
 *  line (see `Proposal.supersedes`) rather than being appended. */
export type ProposalKind =
  | 'tool_failure' | 'tool_denied' | 'interrupted' | 'user_correction'
  | 'learned_fact' | 'fact_conflict' | 'extracted_context'

export type ProposalStatus = 'pending' | 'accepted' | 'rejected'

export interface Proposal {
  id: string
  /** sha256[:16] of the normalized signal — what dedupes repeats. */
  signature: string
  kind: ProposalKind | string
  toolName: string
  /** 'AGENTS.md' | 'MEMORY.md' — the file that gets appended to on accept. */
  targetFile: string
  /** The literal markdown line to be written. Show this verbatim: it is the
   *  thing the user is consenting to put on disk. */
  draft: string
  rationale: string
  /** How many times the underlying signal repeated. */
  hits: number
  status: ProposalStatus | string
  createdAt: number
  /** 0 while pending. */
  decidedAt: number
  /** True only if the append actually landed on disk. */
  applied: boolean
  /** 被这条提案取代的旧行原文。非空 = 批准即**替换**那一行，而不是追加；
   *  UI 必须把它显示出来，用户裁决的正是"留哪一条"。 */
  supersedes?: string
  /** 效果回访三态：effective / improving / ineffective。空 = 未到回访年龄
   *  （生效未满 7 天），UI 不显示徽标。 */
  effect?: string
  effectReviewedAt?: number
  /** 生效前 14 天基线窗口的复发次数——徽标悬停里的"基线 N 次"数字。 */
  effectBaseline?: number
  userTitle?: string
  userAdvice?: string
  userReason?: string
  category?: string
}


/** Verbatim passthrough of the backend's `decide()` return value. */
export interface DecideResult {
  ok: boolean
  status: string
  applied: boolean
  error: string
}

export interface Observation {
  id: string
  decision: string
  goalId?: string
  sessionId?: string
  reason: string
  usedSkills?: string[]
  validatedSkills?: string[]
  createdAt?: number
}

/** The live thresholds for the current mode, straight from `MODE_POLICIES`.
 *  Empty object when mode is `off` — off has no policy row, and inventing one
 *  would put fake numbers in front of the user. */
export interface EvolutionPolicy {
  minHits?: number
  maxOpen?: number
  rejectCooldownDays?: number
}

/** Lifetime status totals straight from a `GROUP BY status` in the backend.
 *  Deliberately NOT derived from `history`: that list is capped by `limit`, so
 *  counting it under-reports the moment the trail grows past the cap. */
export interface ProposalCounts {
  pending: number
  accepted: number
  rejected: number
  total: number
}

/** Which operation an error came from. One slot per source, because a single
 *  shared `error` string let ~10 writers clobber each other — a background
 *  history refetch failing would erase the decide() failure the user needs to
 *  read, and vice versa. */
export type ErrorSource = 'load' | 'mode' | 'history' | 'decide' | 'mine'

export type EvolutionErrors = Partial<Record<ErrorSource, string>>

interface EvolutionState {
  mode: EvolutionMode
  /** The last mode the SERVER confirmed. `mode` may be an unconfirmed optimistic
   *  value mid-flight, so rollback must target this instead — rolling back to
   *  `mode` would restore a value the server never had. */
  confirmedMode: EvolutionMode
  /** Monotonic ticket for mode PUTs. A late response or rejection from a
   *  superseded request must not overwrite newer intent. */
  modeSeq: number
  validModes: EvolutionMode[]
  /** Real thresholds for `mode`. Never hardcode these in copy. */
  policy: EvolutionPolicy
  /** status === 'pending', ordered hits DESC — the review queue. */
  pending: Proposal[]
  /** How many proposals await review. Tracked separately from `pending.length`
   *  because the sidebar badge must be right even when the page was never
   *  opened — the WS event carries this count, no fetch required. */
  openCount: number
  /** Every proposal including decided ones, created DESC — the audit trail.
   *  Capped by `historyLimit`; use `counts` for totals, never `history.length`. */
  history: Proposal[]
  /** The cap `history` was fetched with, so the UI can say "most recent N". */
  historyLimit: number
  counts: ProposalCounts
  loading: boolean
  loaded: boolean
  /** A refresh in flight (mode change, mine). Distinct from `loading`: a refresh
   *  keeps the existing content on screen and shows a small spinner; it never
   *  swaps in the full-page skeleton, which would read as a flash. */
  refreshing: boolean
  mining: boolean
  errors: EvolutionErrors
  /** Proposal ids with an accept/reject in flight, for per-row disabling. */
  busyIds: Set<string>
  /** Last decide() outcome, so the page can distinguish
   *  "accepted and written" from "accepted but the write failed". */
  lastDecision: (DecideResult & { id: string }) | null
  /** Step C 观察台账：任务终态看到了什么证据、四路决策是什么。 */
  observations: Observation[]
  observationsLoaded: boolean

  fetchObservations: () => Promise<void>

  fetchPending: () => Promise<void>
  fetchMode: () => Promise<void>
  fetchHistory: (limit?: number) => Promise<void>
  setMode: (mode: EvolutionMode) => Promise<void>
  /** `draft` overrides the machine-composed text when the user edited it. */
  decide: (id: string, accept: boolean, draft?: string) => Promise<void>
  mine: () => Promise<number>
  undoProposal: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** Called from the WS bridge when the backend mined something new. */
  onProposalEvent: (openCount: number) => void
  clearError: (source?: ErrorSource) => void
  dismissDecision: () => void
}

/** Normalise at the trust boundary: a missing key from an older backend must
 *  cost one card, not the whole page. */
function toProposal(p: any): Proposal {
  return {
    id: String(p?.id ?? ''),
    signature: String(p?.signature ?? ''),
    kind: String(p?.kind ?? ''),
    toolName: String(p?.toolName ?? ''),
    targetFile: String(p?.targetFile ?? ''),
    draft: String(p?.draft ?? ''),
    rationale: String(p?.rationale ?? ''),
    hits: Number(p?.hits ?? 0),
    status: String(p?.status ?? 'pending'),
    createdAt: Number(p?.createdAt ?? 0),
    decidedAt: Number(p?.decidedAt ?? 0),
    applied: Boolean(p?.applied),
    supersedes: p?.supersedes ? String(p.supersedes) : undefined,
    effect: p?.effect ? String(p.effect) : undefined,
    effectReviewedAt: Number(p?.effectReviewedAt ?? 0) || undefined,
    effectBaseline: Number(p?.effectBaseline ?? 0) || undefined,
  }
}

function msg(e: any): string {
  return e?.message || String(e)
}

function toCounts(c: any): ProposalCounts {
  return {
    pending: Number(c?.pending ?? 0),
    accepted: Number(c?.accepted ?? 0),
    rejected: Number(c?.rejected ?? 0),
    total: Number(c?.total ?? 0),
  }
}

/** Write one source's error without touching the others. */
function withError(prev: EvolutionErrors, source: ErrorSource, text: string): EvolutionErrors {
  return { ...prev, [source]: text }
}

/** Clear one source's error without touching the others. */
function withoutError(prev: EvolutionErrors, source: ErrorSource): EvolutionErrors {
  if (!prev[source]) return prev
  const next = { ...prev }
  delete next[source]
  return next
}

export const useEvolutionStore = create<EvolutionState>((set, get) => ({
  mode: 'off',
  confirmedMode: 'off',
  modeSeq: 0,
  validModes: ['off', 'cautious', 'active'],
  policy: {},
  pending: [],
  openCount: 0,
  history: [],
  historyLimit: 50,
  counts: { pending: 0, accepted: 0, rejected: 0, total: 0 },
  loading: false,
  loaded: false,
  refreshing: false,
  mining: false,
  errors: {},
  busyIds: new Set(),
  lastDecision: null,
  observations: [],
  observationsLoaded: false,

  fetchObservations: async () => {
    try {
      const data = await fetchJson<{ observations: Observation[] }>(
        `${API_BASE}/api/evolution/observations?limit=50`
      )
      set({ observations: Array.isArray(data?.observations) ? data.observations : [],
             observationsLoaded: true })
    } catch {
      // 拉取失败不阻塞页面其余部分；留空，下次进入重试。
      set({ observationsLoaded: true })
    }
  },

  // No argument clears everything (the banner's dismiss button); a source clears
  // just that row, so dismissing a stale history error can't hide a live one.
  clearError: (source?: ErrorSource) =>
    set((s) => ({ errors: source ? withoutError(s.errors, source) : {} })),
  dismissDecision: () => set({ lastDecision: null }),

  // `/proposals` returns mode alongside the queue, so one call seeds both and
  // the mode selector can't disagree with what produced the list.
  fetchPending: async () => {
    set({ loading: true })
    try {
      const d = await fetchJson<{ mode: string; proposals: any[] }>(
        `${API_BASE}/api/evolution/proposals`,
      )
      const proposals = (d.proposals || []).map(toProposal)
      const mode = (d.mode || 'off') as EvolutionMode
      set((s) => ({
        mode, confirmedMode: mode,
        pending: proposals,
        openCount: proposals.length,
        loading: false, loaded: true,
        errors: withoutError(s.errors, 'load'),
      }))
    } catch (e: any) {
      set((s) => ({
        loading: false, loaded: true, errors: withError(s.errors, 'load', msg(e)),
      }))
    }
  },

  // The mode endpoint is the only source of the live policy thresholds. Fetch
  // it on mount so the mode hints show real numbers, not hardcoded ones.
  fetchMode: async () => {
    try {
      const d = await fetchJson<{ mode: string; validModes: string[]; policy: any }>(
        `${API_BASE}/api/evolution/mode`,
      )
      const mode = (d.mode || 'off') as EvolutionMode
      set((s) => ({
        mode, confirmedMode: mode,
        validModes: (d.validModes || ['off', 'cautious', 'active']) as EvolutionMode[],
        policy: d.policy || {},
        errors: withoutError(s.errors, 'mode'),
      }))
    } catch (e: any) {
      set((s) => ({ errors: withError(s.errors, 'mode', msg(e)) }))
    }
  },

  fetchHistory: async (limit = 50) => {
    try {
      // NOTE: `/proposals/all` deliberately has no `mode` key — don't read one.
      // `counts` IS separate from `proposals`: the list is capped by `limit`,
      // the counts are a full GROUP BY. Never derive totals from the list.
      const d = await fetchJson<{ proposals: any[]; counts?: any; limit?: number }>(
        `${API_BASE}/api/evolution/proposals/all?limit=${limit}`,
      )
      set((s) => ({
        history: (d.proposals || []).map(toProposal),
        historyLimit: Number(d.limit ?? limit),
        counts: toCounts(d.counts),
        errors: withoutError(s.errors, 'history'),
      }))
    } catch (e: any) {
      set((s) => ({ errors: withError(s.errors, 'history', msg(e)) }))
    }
  },

  setMode: async (mode: EvolutionMode) => {
    // Ticket this request. A second click supersedes the first, and the loser's
    // response — success OR failure — must be dropped rather than applied on
    // top of newer intent.
    const seq = get().modeSeq + 1
    set((s) => ({ mode, modeSeq: seq, errors: withoutError(s.errors, 'mode') }))
    try {
      const d = await sendJson<{ mode: string }>(
        `${API_BASE}/api/evolution/mode`, 'PUT', { mode },
      )
      if (get().modeSeq !== seq) return
      const confirmed = (d.mode || mode) as EvolutionMode
      set({ mode: confirmed, confirmedMode: confirmed })
      // Pull the fresh policy for the new mode, then reveal any queue that was
      // already there. `refreshing` (not `loading`) keeps the existing content
      // on screen — swapping in the full skeleton would flash the interface.
      set({ refreshing: true })
      try {
        await get().fetchMode()
        await get().fetchPending()
      } finally {
        set({ refreshing: false })
      }
    } catch (e: any) {
      if (get().modeSeq !== seq) return
      // Roll back to the last SERVER-CONFIRMED mode, not to whatever `mode` held
      // when this call started — that may itself have been an unconfirmed
      // optimistic value from a previous click, i.e. a state the server never had.
      set((s) => ({ mode: s.confirmedMode, errors: withError(s.errors, 'mode', msg(e)) }))
    }
  },

  decide: async (id: string, accept: boolean, draft?: string) => {
    const busy = new Set(get().busyIds)
    busy.add(id)
    // Optimistically drop the card so the queue feels responsive — the button
    // shouldn't sit disabled while the round-trip and refetch complete. If the
    // call fails, fetchPending() in `finally` puts it back.
    set((s) => ({
      busyIds: busy,
      errors: withoutError(s.errors, 'decide'),
      pending: s.pending.filter((p) => p.id !== id),
    }))
    try {
      const verb = accept ? 'accept' : 'reject'
      const d = await sendJson<DecideResult>(
        `${API_BASE}/api/evolution/proposals/${encodeURIComponent(id)}/${verb}`,
        'POST',
        accept && draft ? { draft } : undefined,
      )
      // `applied` is the honest on-disk result. An accept whose write failed
      // must NOT read as success, so it is surfaced rather than swallowed.
      set({ lastDecision: { ...d, id } })
      if (!d.ok && d.error) set((s) => ({ errors: withError(s.errors, 'decide', d.error) }))
    } catch (e: any) {
      set((s) => ({ errors: withError(s.errors, 'decide', msg(e)) }))
    } finally {
      const next = new Set(get().busyIds)
      next.delete(id)
      set({ busyIds: next })
      await get().fetchPending()
      // The trail is refetched unconditionally: it also carries `counts`, and
      // the accepted/rejected tiles are wrong until those are re-read.
      await get().fetchHistory(get().historyLimit)
    }
  },

  /** Manual mine. Returns how many proposals appeared — 0 is the common,
   *  correct answer (throttle window, hits below threshold, or max_open full). */
  mine: async () => {
    set((s) => ({ mining: true, errors: withoutError(s.errors, 'mine') }))
    try {
      const d = await sendJson<{ created: any[] }>(
        `${API_BASE}/api/evolution/mine`, 'POST',
      )
      const created = (d.created || []).length
      await get().fetchPending()
      return created
    } catch (e: any) {
      set((s) => ({ errors: withError(s.errors, 'mine', msg(e)) }))
      return 0
    } finally {
      set({ mining: false })
    }
  },

  undoProposal: async (id: string) => {
    try {
      const res = await sendJson<{ ok: boolean; error?: string; data?: any }>(
        `${API_BASE}/api/evolution/undo`,
        'POST',
        { proposal_id: id },
      )
      if (res && res.ok) {
        await get().fetchHistory(get().historyLimit)
        await get().fetchPending()
        return { ok: true }
      }
      return { ok: false, error: res?.error || '撤销失败' }
    } catch (e: any) {
      return { ok: false, error: msg(e) }
    }
  },

  // WS told us the backend mined something during a conversation. The count
  // lands immediately so the sidebar badge is right even if this page has never
  // been opened; the full list is only refetched when the page is mounted.
  onProposalEvent: (openCount: number) => {
    set({ openCount: Number.isFinite(openCount) ? openCount : get().openCount })
    if (get().loaded) void get().fetchPending()
  },
}))
