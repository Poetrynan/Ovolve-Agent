import type { Goal } from '@apptypes/index'

/** Coerce anything to a finite number, falling back to `fallback`. */
export function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Normalize one goal off the wire into a fully-populated `Goal`.
 *
 * Every numeric field is coerced and every optional field is defaulted here, so
 * no consumer has to guard. This is not paranoia about a hypothetical payload:
 * an older backend process serves the raw snake_case DB row with no `costUsd`
 * at all, and `undefined <= 0` is false in JS — so a missing field sailed past
 * the render guard and threw on `.toFixed()`, blanking the whole page. One
 * normalization boundary is cheaper than N guards at every read site.
 *
 * Lives in its own module (rather than in goalStore) so it can be unit-tested
 * without dragging in the API layer, which touches `window.location` at import
 * time and blows up under a bare test environment.
 */
export function normalizeGoal(raw: any): Goal {
  const rawMax = raw?.maxIterations ?? raw?.max_iterations
  const maxIterations = num(rawMax, 10)
  const subtasksTotal = num(raw?.subtasksTotal ?? raw?.subtasks_total, 0)
  const subtasksCompleted = num(raw?.subtasksCompleted ?? raw?.subtasks_completed, 0)
  const rawRatio = raw?.progressRatio ?? raw?.progress_ratio
  return {
    id: String(raw?.id ?? ''),
    description: String(raw?.description ?? ''),
    status: (raw?.status ?? 'started') as Goal['status'],
    iteration: num(raw?.iteration, 0),
    maxIterations: maxIterations > 0 ? maxIterations : 10,
    // Whether that ceiling came from the backend or is our own 10. The number
    // itself is a harmless internal default, but rendering "第 3 / 10 轮" off an
    // invented denominator states a specific falsehood about the budget — and
    // looks byte-identical to a real one. Consumers check this before showing it.
    maxIterationsKnown: num(rawMax, 0) > 0,
    subtasksCompleted,
    subtasksTotal,
    // Only trust a ratio when there is actually a plan to count against;
    // otherwise null, which tells the UI to render a label, not a bar.
    progressRatio:
      subtasksTotal > 0 && rawRatio !== null && rawRatio !== undefined
        ? num(rawRatio, 0)
        : null,
    plan: Array.isArray(raw?.plan) ? raw.plan : [],
    costUsd: num(raw?.costUsd ?? raw?.cost_usd, 0),
    costCapUsd: num(raw?.costCapUsd ?? raw?.cost_cap_usd, 0),
    tokensUsed: num(raw?.tokensUsed ?? raw?.tokens_used, 0),
    lastError: String(raw?.lastError ?? raw?.last_error ?? ''),
    verification: raw?.verification ?? null,
    sessionId: String(raw?.sessionId ?? raw?.session_id ?? ''),
    createdAt: num(raw?.createdAt ?? raw?.created_at, 0),
    updatedAt: num(raw?.updatedAt ?? raw?.updated_at, 0),
    startedAt: num(raw?.startedAt ?? raw?.started_at, 0),
  }
}
