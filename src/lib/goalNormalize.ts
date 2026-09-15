import type { Goal, GoalDeliveryHints } from '../types/goal'

/** Coerce anything to a finite number, falling back to `fallback`. */
export function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

const GOAL_STAGE_VALUES = ['plan', 'execute', 'verify'] as const

/**
 * Validate the fine-grained pipeline `stage` off the wire (P1-4).
 *
 * goal_scheduler emits exactly these three values on `goal_state_change`;
 * anything else — absent, junk, an older backend — is null, which tells the
 * pipeline UI to derive the phase from status alone.
 */
export function stageFromWire(v: unknown): Goal['stage'] {
  return (GOAL_STAGE_VALUES as readonly string[]).includes(v as string)
    ? (v as Goal['stage'])
    : null
}

/**
 * Validate the delivery-hints aggregate off the wire (U5 佐证).
 *
 * Backend emits `{deliverable_count, handoff_count, latest_handoff_detail}`
 * on goal_state_change; anything else — absent, junk, an older backend — is
 * null, which tells the pipeline UI to render no evidence chip. Counts are
 * coerced and floored at 0: a negative or junk count is junk, not evidence.
 */
export function deliveryHintsFromWire(v: unknown): GoalDeliveryHints | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const raw = v as Record<string, any>
  const count = (x: unknown): number => Math.max(0, Math.floor(num(x, 0)))
  return {
    deliverableCount: count(raw.deliverable_count ?? raw.deliverableCount),
    handoffCount: count(raw.handoff_count ?? raw.handoffCount),
    latestHandoffDetail: String(raw.latest_handoff_detail ?? raw.latestHandoffDetail ?? ''),
  }
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
    // Fine-grained pipeline phase (P1-4). Only the three values the scheduler
    // actually emits survive; anything else (the REST row has no stage at all)
    // is null so the UI falls back to deriving the phase from status.
    stage: stageFromWire(raw?.stage),
    // U5 接管信号与佐证聚合：REST 行不带这些字段（只有 WS 事件带），
    // 归一层统一给"无信号"默认值——handoffRequired 只认严格 true。
    handoffRequired: raw?.handoff_required === true || raw?.handoffRequired === true,
    handoffDetail: String(raw?.handoff_detail ?? raw?.handoffDetail ?? ''),
    deliveryHints: deliveryHintsFromWire(raw?.delivery_hints ?? raw?.deliveryHints),
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
