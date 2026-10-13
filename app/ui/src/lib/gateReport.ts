/**
 * gateReport.ts — one honest reading of a skill candidate's gate report.
 *
 * Two pages render this map (ApprovalsPage, SkillsPage) and both did it the
 * same wrong way: `g.ok ? '✓' : '✕'`. Any entry that is not shaped exactly
 * `{ok, detail}` therefore rendered as a red failure — including the
 * `verification_run` record, whose shape is `{ran, machineVerified, detail,
 * returncode, confinement}`. A user looking at a perfectly healthy skill saw a
 * red ✕ next to the very gate that had passed, which is worse than showing
 * nothing: it teaches people to ignore the report.
 *
 * So: a boolean `ok` means pass/fail. No `ok` means this entry is a *record*,
 * not a verdict, and it renders neutral with its facts spelled out.
 */

export type GateTone = 'ok' | 'fail' | 'info'

export interface GateView {
  tone: GateTone
  mark: string
  detail: string
}

/** Fields worth surfacing when an entry carries no verdict. */
const FACT_KEYS = ['ran', 'machineVerified', 'returncode', 'confinement', 'timeout', 'error']

export function readGate(raw: unknown): GateView {
  if (raw === null || typeof raw !== 'object') {
    return { tone: 'info', mark: 'ℹ', detail: String(raw ?? '') }
  }
  const g = raw as Record<string, unknown>
  const detail = typeof g.detail === 'string' ? g.detail : ''

  if (typeof g.ok === 'boolean') {
    return { tone: g.ok ? 'ok' : 'fail', mark: g.ok ? '✓' : '✕', detail }
  }

  // No verdict: state what was recorded instead of inventing one.
  const facts = FACT_KEYS.filter((k) => g[k] !== undefined && g[k] !== '')
    .map((k) => `${k}=${String(g[k])}`)
  const joined = [detail, facts.join(' ')].filter(Boolean).join(' — ')
  return { tone: 'info', mark: 'ℹ', detail: joined }
}
