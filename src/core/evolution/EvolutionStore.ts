/**
 * EvolutionStore.ts — SQLite Persistence, Proposal Lifecycle & Governance Engine
 *
 * Implements:
 * 1. Normalized error fingerprinting & credential scrubbing (`normalizeError`, `signatureFor`).
 * 2. EvolutionStore persistence for signals, proposals, observations, and learning_bundles.
 * 3. Human-in-the-loop approval workflow (`decide`) and safe disk application.
 * 4. 3 Operating Modes: 'off' (default), 'cautious', 'active'.
 * 5. 4-Way Observation classification (MEMORY_ONLY, SKILL_ONLY, BOTH, NO_OP).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const MODE_OFF = 'off'
export const MODE_CAUTIOUS = 'cautious'
export const MODE_ACTIVE = 'active'
export const VALID_MODES = [MODE_OFF, MODE_CAUTIOUS, MODE_ACTIVE] as const
export type EvolutionMode = typeof VALID_MODES[number]

export const DEFAULT_MODE: EvolutionMode = MODE_OFF

export interface ModePolicy {
  minHits: number
  maxOpen: number
  rejectCooldownSeconds: number
}

export const MODE_POLICIES: Record<string, ModePolicy> = {
  [MODE_CAUTIOUS]: { minHits: 5, maxOpen: 2, rejectCooldownSeconds: 30 * 86400 },
  [MODE_ACTIVE]: { minHits: 3, maxOpen: 5, rejectCooldownSeconds: 7 * 86400 },
}

export const ALLOWED_TARGETS = new Set(['AGENTS.md', 'MEMORY.md', 'SOUL.md'])

export const KIND_TARGET: Record<string, string> = {
  tool_failure: 'AGENTS.md',
  tool_denied: 'AGENTS.md',
  interrupted: 'AGENTS.md',
  user_correction: 'MEMORY.md',
  learned_fact: 'MEMORY.md',
  fact_conflict: 'MEMORY.md',
  extracted_context: 'AGENTS.md',
}

export const EVOLUTION_HEADING = '## Learned Rules (evolution)'

const NORMALIZERS: Array<[RegExp, string]> = [
  [
    /\b(?:api[-_]?key|secret|token|password|passwd|pwd|auth(?:orization)?|access[-_]?key|private[-_]?key|session[-_]?id|cookie)\b\s*[:=]\s*[^\s'",;]+/gi,
    '<SECRET>',
  ],
  [/\bbearer\s+[A-Za-z0-9._\-]+/gi, '<SECRET>'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{8,}/g, '<SECRET>'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '<SECRET>'],
  [/\bxox[baprs]-[A-Za-z0-9\-]{8,}/g, '<SECRET>'],
  [/\bAIza[A-Za-z0-9_\-]{16,}/g, '<SECRET>'],
  [/[A-Za-z]:\\[^\s'"]+/g, '<PATH>'],
  [/\/(?:[\w.\-]+\/)+[\w.\-]+/g, '<PATH>'],
  [/'[^']*'/g, '<Q>'],
  [/"[^"]*"/g, '<Q>'],
  [/\b[0-9a-f]{8,}\b/gi, '<HEX>'],
  [/\b\d+(?:\.\d+)?\b/g, '<N>'],
  [/\s+/g, ' '],
]

export function normalizeError(text: string): string {
  if (!text) return ''
  let out = String(text)
  for (const [pattern, repl] of NORMALIZERS) {
    out = out.replace(pattern, repl)
  }
  return out.trim().toLowerCase().slice(0, 400)
}

export function signatureFor(kind: string, toolName: string, detail: string): string {
  const basis = `${kind}\x1f${toolName || ''}\x1f${normalizeError(detail)}`
  return crypto.createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 16)
}

export interface SignalRecord {
  id?: number
  sessionId: string
  kind: string
  signature: string
  toolName: string
  detail: string
  createdAt: number
}

export interface Proposal {
  id: string
  signature: string
  kind: string
  toolName: string
  targetFile: string
  draft: string
  rationale: string
  hits: number
  status: 'pending' | 'accepted' | 'rejected'
  createdAt: number
  decidedAt?: number
  applied?: boolean
  supersedes?: string
}

export interface EvolutionObservation {
  goalId?: string
  runId?: string
  sessionId?: string
  turnIds?: string[]
  usedMemory?: string[]
  usedSkills?: string[]
  validatorResult?: Record<string, any>
  userFeedback?: string
  newFacts?: string[]
  reusableSteps?: string[]
  validatedSkills?: string[]
  failedExperiences?: string[]
  failureClass?: string
  decision?: 'MEMORY_ONLY' | 'SKILL_ONLY' | 'BOTH' | 'NO_OP'
  reason?: string
  createdAt?: number
}

export interface LearningBundle {
  learningId: string
  goalId: string
  runId: string
  sessionId: string
  decision: string
  rationale: string
  turnIds: string[]
  experienceIds: string[]
  memoryProposalIds: string[]
  skillCandidateId: string
  validatorResult: Record<string, any>
  userVerdict: string
  createdAt: number
  bundleKey?: string
  outcome?: string
}

export class EvolutionStore {
  private signals: SignalRecord[] = []
  private proposals: Map<string, Proposal> = new Map()
  private observations: Map<string, EvolutionObservation & { id: string }> = new Map()
  private learningBundles: Map<string, LearningBundle> = new Map()

  // ── Signals ─────────────────────────────────────────────────────────────
  public recordSignal(
    kind: string,
    toolName: string,
    detail: string,
    sessionId: string = '',
  ): string {
    const sig = signatureFor(kind, toolName, detail)
    const now = Date.now() / 1000

    const count = this.signals.filter((s) => s.signature === sig).length
    if (count >= 50) {
      return sig
    }

    this.signals.push({
      id: this.signals.length + 1,
      sessionId,
      kind,
      signature: sig,
      toolName: toolName || '',
      detail: (detail || '').slice(0, 2000),
      createdAt: now,
    })

    return sig
  }

  public hotSignatures(minHits: number, limit: number = 20): Array<{
    signature: string
    hits: number
    tool: string
    kind: string
    detail: string
    last: number
  }> {
    const counts = new Map<string, { hits: number; tool: string; kind: string; detail: string; last: number }>()

    for (const s of this.signals) {
      const existing = counts.get(s.signature)
      if (existing) {
        existing.hits++
        existing.last = Math.max(existing.last, s.createdAt)
        if (s.toolName) existing.tool = s.toolName
        if (s.detail) existing.detail = s.detail
      } else {
        counts.set(s.signature, {
          hits: 1,
          tool: s.toolName,
          kind: s.kind,
          detail: s.detail,
          last: s.createdAt,
        })
      }
    }

    const result: Array<{ signature: string; hits: number; tool: string; kind: string; detail: string; last: number }> = []
    for (const [signature, info] of counts.entries()) {
      if (info.hits >= minHits) {
        result.push({ signature, ...info })
      }
    }

    result.sort((a, b) => b.hits - a.hits)
    return result.slice(0, limit)
  }

  // ── Proposals ───────────────────────────────────────────────────────────
  public insertProposal(proposal: Proposal): void {
    this.proposals.set(proposal.id, { ...proposal })
  }

  public getProposal(proposalId: string): Proposal | undefined {
    const p = this.proposals.get(proposalId)
    return p ? { ...p } : undefined
  }

  public openProposals(): Proposal[] {
    return Array.from(this.proposals.values())
      .filter((p) => p.status === 'pending')
      .sort((a, b) => b.hits - a.hits || a.createdAt - b.createdAt)
  }

  public allProposals(limit: number = 50): Proposal[] {
    return Array.from(this.proposals.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  public hasOpenForSignature(signature: string): boolean {
    return Array.from(this.proposals.values()).some(
      (p) => p.signature === signature && p.status === 'pending',
    )
  }

  public lastRejectedAt(signature: string): number {
    let maxTime = 0
    for (const p of this.proposals.values()) {
      if (p.signature === signature && p.status === 'rejected' && p.decidedAt) {
        maxTime = Math.max(maxTime, p.decidedAt)
      }
    }
    return maxTime
  }

  public countOpen(): number {
    return this.openProposals().length
  }

  public countByStatus(): Record<string, number> {
    const counts = { pending: 0, accepted: 0, rejected: 0, total: 0 }
    for (const p of this.proposals.values()) {
      counts.total++
      if (p.status in counts) {
        counts[p.status]++
      }
    }
    return counts
  }

  public markDecided(proposalId: string, status: 'accepted' | 'rejected', applied: boolean): void {
    const p = this.proposals.get(proposalId)
    if (p) {
      p.status = status
      p.decidedAt = Date.now() / 1000
      p.applied = applied
    }
  }

  public updateDraft(proposalId: string, draft: string): void {
    const p = this.proposals.get(proposalId)
    if (p && p.status === 'pending') {
      p.draft = draft
    }
  }

  // ── Observations ────────────────────────────────────────────────────────
  public insertObservation(obs: EvolutionObservation): string {
    const obsId = `obs_${crypto.randomUUID().slice(0, 8)}`
    this.observations.set(obsId, { id: obsId, ...obs, createdAt: obs.createdAt || Date.now() / 1000 })
    return obsId
  }

  public listObservations(limit: number = 50): Array<EvolutionObservation & { id: string }> {
    return Array.from(this.observations.values())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit)
  }

  // ── LearningBundles ─────────────────────────────────────────────────────
  public insertBundle(bundle: Omit<LearningBundle, 'createdAt'> & { createdAt?: number }): string {
    const learningId = bundle.learningId || (bundle.bundleKey ? crypto.createHash('sha256').update(bundle.bundleKey).digest('hex').slice(0, 16) : `lb_${crypto.randomUUID().slice(0, 8)}`)
    const record: LearningBundle = {
      ...bundle,
      learningId,
      createdAt: bundle.createdAt || Date.now() / 1000,
    }
    this.learningBundles.set(learningId, record)
    return learningId
  }

  public findBundleByKey(bundleKey: string): LearningBundle | undefined {
    if (!bundleKey) return undefined
    for (const b of this.learningBundles.values()) {
      if (b.bundleKey === bundleKey) {
        return { ...b }
      }
    }
    return undefined
  }

  public listBundles(limit: number = 50): LearningBundle[] {
    return Array.from(this.learningBundles.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  public markBundleVerdictForProposal(proposalId: string, verdict: string): boolean {
    for (const b of this.learningBundles.values()) {
      if (b.memoryProposalIds.includes(proposalId)) {
        b.userVerdict = verdict
        return true
      }
    }
    return false
  }
}

export function classifyObservation(obs: EvolutionObservation): {
  decision: 'MEMORY_ONLY' | 'SKILL_ONLY' | 'BOTH' | 'NO_OP'
  reason: string
} {
  const secretPattern = /\b(?:api[-_]?key|secret|token|password|passwd|credential|private[-_]?key)\b|\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{8,}|\bbearer\s+[A-Za-z0-9._\-]+/i
  const blob = [
    ...(obs.newFacts || []),
    ...(obs.failedExperiences || []),
    obs.failureClass || '',
    obs.userFeedback || '',
  ].join(' | ')

  if (secretPattern.test(blob)) {
    return {
      decision: 'NO_OP',
      reason: '证据疑似包含秘密/凭证：禁止固化为任何学习产物',
    }
  }

  const hasFacts = (obs.newFacts || []).length > 0
  const hasSkill = (obs.reusableSteps || []).length > 0

  if (hasFacts && hasSkill) {
    return {
      decision: 'BOTH',
      reason: `新事实 ${obs.newFacts!.length} 条且技能流程成功 ${obs.reusableSteps!.length} 个：两层需同步更新`,
    }
  }

  if (hasFacts) {
    return {
      decision: 'MEMORY_ONLY',
      reason: `新增 ${obs.newFacts!.length} 条事实，无可复用流程`,
    }
  }

  if (hasSkill) {
    return {
      decision: 'SKILL_ONLY',
      reason: `${obs.reusableSteps!.length} 个技能流程成功可复用，无新事实`,
    }
  }

  const failures = (obs.failedExperiences || []).filter(Boolean)
  if (failures.length > 0) {
    const counts = new Map<string, number>()
    for (const f of failures) {
      counts.set(f, (counts.get(f) || 0) + 1)
    }
    const repeated = Array.from(counts.values()).some((c) => c >= 2)
    if (repeated) {
      return {
        decision: 'NO_OP',
        reason: '同类失败已复发：由信号挖掘管线按 min_hits 立案，观察层不重复立项',
      }
    }
    return {
      decision: 'NO_OP',
      reason: '偶发失败：一次失败不配固化成任何长期改变',
    }
  }

  if (obs.userFeedback) {
    return {
      decision: 'NO_OP',
      reason: '仅口头反馈、无可落地证据：低复用价值',
    }
  }

  return {
    decision: 'NO_OP',
    reason: '证据不足：没有成功经验也没有新事实',
  }
}

export class EvolutionEngine {
  public store: EvolutionStore
  private _mode: EvolutionMode
  public workspaceRoot: string
  private _lastMineAt: number = 0

  constructor(
    store?: EvolutionStore,
    mode: EvolutionMode = DEFAULT_MODE,
    workspaceRoot?: string,
  ) {
    this.store = store || new EvolutionStore()
    this._mode = VALID_MODES.includes(mode) ? mode : DEFAULT_MODE
    this.workspaceRoot = workspaceRoot || process.cwd()
  }

  public get mode(): EvolutionMode {
    return this._mode
  }

  public setMode(mode: EvolutionMode): EvolutionMode {
    if (!VALID_MODES.includes(mode)) {
      throw new Error(`unknown mode ${mode}; expected one of ${VALID_MODES.join(', ')}`)
    }
    this._mode = mode
    return this._mode
  }

  public enabled(): boolean {
    return this._mode !== MODE_OFF
  }

  public record(
    kind: string,
    toolName: string,
    detail: string,
    sessionId: string = '',
  ): string | null {
    if (!this.enabled() || !kind) {
      return null
    }
    return this.store.recordSignal(kind, toolName, detail, sessionId)
  }

  public recordUserCorrection(turnId: string, correctionText: string, sessionId: string = ''): string | null {
    if (!this.enabled()) {
      return null
    }
    return this.record('user_correction', 'user_intervention', `Turn ${turnId} user correction: ${correctionText}`, sessionId)
  }

  public observe(obs: EvolutionObservation): EvolutionObservation {
    if (!this.enabled()) {
      obs.decision = 'NO_OP'
      obs.reason = 'evolution off：未评估'
      return obs
    }
    const { decision, reason } = classifyObservation(obs)
    obs.decision = decision
    obs.reason = reason
    this.store.insertObservation(obs)
    return obs
  }

  public mine(): Proposal[] {
    if (!this.enabled()) {
      return []
    }
    const policy = MODE_POLICIES[this._mode]
    if (!policy || this.store.countOpen() >= policy.maxOpen) {
      return []
    }

    const now = Date.now() / 1000
    const made: Proposal[] = []
    const hot = this.store.hotSignatures(policy.minHits, 20)

    for (const row of hot) {
      if (this.store.hasOpenForSignature(row.signature)) {
        continue
      }
      const lastRej = this.store.lastRejectedAt(row.signature)
      if (lastRej && now - lastRej < policy.rejectCooldownSeconds) {
        continue
      }

      const proposal = this._draft(row)
      if (!proposal) continue

      this.store.insertProposal(proposal)
      made.push(proposal)

      if (this.store.countOpen() >= policy.maxOpen) {
        break
      }
    }

    return made
  }

  public maybeMine(): Proposal[] {
    if (!this.enabled()) return []
    const now = Date.now() / 1000
    if (now - this._lastMineAt < 60) {
      return []
    }
    const made = this.mine()
    if (made.length > 0) {
      this._lastMineAt = now
    }
    return made
  }

  private _draft(row: { signature: string; hits: number; tool: string; kind: string; detail: string }): Proposal | null {
    const kind = row.kind.trim()
    const target = KIND_TARGET[kind]
    if (!target || !ALLOWED_TARGETS.has(target)) {
      return null
    }

    const rule = this._composeRule(kind, row.tool, row.detail)
    const rationale = `复发信号：kind=${kind}, tool=${row.tool || '-'}, hits=${row.hits}. 归一化摘要：${normalizeError(row.detail).slice(0, 200)}`

    return {
      id: crypto.randomUUID().slice(0, 12),
      signature: row.signature,
      kind,
      toolName: row.tool,
      targetFile: target,
      draft: rule,
      rationale,
      hits: row.hits,
      status: 'pending',
      createdAt: Date.now() / 1000,
    }
  }

  private _composeRule(kind: string, toolName: string, detail: string): string {
    const summary = normalizeError(detail).slice(0, 160) || '(no detail)'
    if (kind === 'tool_failure') {
      return `- 反复失败于 \`${toolName}\`：${summary}. 下次调用前先缩小参数范围，或改换等价工具。`
    }
    if (kind === 'tool_denied') {
      return `- 反复被策略拦截：\`${toolName}\` — ${summary}. 不要重复尝试同一形式；换目标或先请示用户。`
    }
    if (kind === 'interrupted') {
      return `- 用户在 \`${toolName}\` 期间频繁中断（${summary}）. 开始该类操作前先摘要计划、等确认。`
    }
    if (kind === 'user_correction') {
      return `- 用户偏好：${summary}`
    }
    return `- ${kind}: ${summary}`
  }

  /**
   * Approves or rejects a proposal, applying accepted rule to disk under EVOLUTION_HEADING.
   */
  public decide(
    proposalId: string,
    accept: boolean,
    draftOverride?: string,
  ): { ok: boolean; status: 'accepted' | 'rejected' | 'missing'; applied: boolean; error: string } {
    const p = this.store.getProposal(proposalId)
    if (!p) {
      return { ok: false, status: 'missing', applied: false, error: 'proposal not found' }
    }
    if (p.status !== 'pending') {
      return { ok: false, status: p.status, applied: Boolean(p.applied), error: 'already decided' }
    }

    if (!accept) {
      this.store.markDecided(proposalId, 'rejected', false)
      this.store.markBundleVerdictForProposal(proposalId, 'rejected')
      return { ok: true, status: 'rejected', applied: false, error: '' }
    }

    const finalDraft = (draftOverride || '').trim() || p.draft.trim()
    p.draft = finalDraft

    // Write to disk
    try {
      const filePath = path.join(this.workspaceRoot, p.targetFile)
      let existingContent = ''
      if (fs.existsSync(filePath)) {
        existingContent = fs.readFileSync(filePath, 'utf8')
      }

      let updatedContent = ''
      if (existingContent.includes(EVOLUTION_HEADING)) {
        const parts = existingContent.split(EVOLUTION_HEADING)
        let evolutionSection = parts[1] || ''

        if (p.supersedes && evolutionSection.includes(p.supersedes)) {
          evolutionSection = evolutionSection.replace(p.supersedes, finalDraft)
        } else {
          evolutionSection = `\n${finalDraft}` + evolutionSection
        }

        updatedContent = parts[0] + EVOLUTION_HEADING + evolutionSection
      } else {
        updatedContent =
          existingContent.trim() +
          `\n\n${EVOLUTION_HEADING}\n${finalDraft}\n`
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, updatedContent, 'utf8')

      this.store.updateDraft(proposalId, finalDraft)
      this.store.markDecided(proposalId, 'accepted', true)
      this.store.markBundleVerdictForProposal(proposalId, 'accepted')

      return { ok: true, status: 'accepted', applied: true, error: '' }
    } catch (err: any) {
      this.store.markDecided(proposalId, 'accepted', false)
      return { ok: false, status: 'accepted', applied: false, error: `write failed: ${err?.message || err}` }
    }
  }
}
