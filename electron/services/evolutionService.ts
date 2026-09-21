import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

// ── Evolution types & constants ─────────────────────────────────────────────

export type EvolutionMode = 'off' | 'cautious' | 'active'

const MODE_POLICIES: Record<string, { minHits: number; maxOpen: number; rejectCooldownSeconds: number }> = {
  cautious: { minHits: 5, maxOpen: 2, rejectCooldownSeconds: 30 * 86400 },
  active: { minHits: 3, maxOpen: 5, rejectCooldownSeconds: 7 * 86400 },
}

const KIND_TARGET: Record<string, string> = {
  tool_failure: 'AGENTS.md',
  tool_denied: 'AGENTS.md',
  interrupted: 'AGENTS.md',
  user_correction: 'MEMORY.md',
  learned_fact: 'MEMORY.md',
  fact_conflict: 'MEMORY.md',
  extracted_context: 'AGENTS.md',
}

const EVOLUTION_HEADING = '## Learned Rules (evolution)'

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

interface SignalRecord {
  sessionId: string
  kind: string
  signature: string
  toolName: string
  detail: string
  createdAt: number
}

function normalizeError(text: string): string {
  if (!text) return ''
  let out = String(text)
  const patterns: Array<[RegExp, string]> = [
    [/\b(?:api[-_]?key|secret|token|password)\b\s*[:=]\s*[^\s'",;]+/gi, '<SECRET>'],
    [/[A-Za-z]:\\[^\s'"]+/g, '<PATH>'],
    [/\/(?:[\w.\-]+\/)+[\w.\-]+/g, '<PATH>'],
    [/\b\d+(?:\.\d+)?\b/g, '<N>'],
    [/\s+/g, ' '],
  ]
  for (const [p, r] of patterns) out = out.replace(p, r)
  return out.trim().toLowerCase().slice(0, 400)
}

function signatureFor(kind: string, toolName: string, detail: string): string {
  const basis = `${kind}\x1f${toolName || ''}\x1f${normalizeError(detail)}`
  return crypto.createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 16)
}

export class EvolutionService {
  private mode: EvolutionMode = 'off'
  private signals: SignalRecord[] = []
  private proposals = new Map<string, Proposal>()
  private dataFile: string
  private workspaceRoot: string

  constructor(configRoot: string, workspaceRoot: string) {
    this.dataFile = path.join(configRoot, 'evolution.json')
    this.workspaceRoot = workspaceRoot
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.dataFile)) {
        const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'))
        this.mode = data.mode || 'off'
        this.signals = data.signals || []
        for (const p of data.proposals || []) this.proposals.set(p.id, p)
      }
    } catch {}
  }

  private save(): void {
    const dir = path.dirname(this.dataFile)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.dataFile, JSON.stringify({
      mode: this.mode,
      signals: this.signals,
      proposals: Array.from(this.proposals.values()),
    }, null, 2))
  }

  getMode(): EvolutionMode { return this.mode }
  setMode(mode: EvolutionMode): void { this.mode = mode; this.save() }

  recordSignal(kind: string, toolName: string, detail: string, sessionId = ''): string {
    const sig = signatureFor(kind, toolName, detail)
    this.signals.push({ sessionId, kind, signature: sig, toolName, detail: detail.slice(0, 2000), createdAt: Date.now() / 1000 })
    this.save()
    if (this.mode !== 'off') this.mine()
    return sig
  }

  mine(): Proposal[] {
    if (this.mode === 'off') return []
    const policy = MODE_POLICIES[this.mode]
    if (!policy) return []

    const open = this.openProposals()
    if (open.length >= policy.maxOpen) return []

    const hot = this.hotSignatures(policy.minHits)
    const created: Proposal[] = []

    for (const h of hot) {
      if (this.hasOpenForSignature(h.signature)) continue
      const lastRej = this.lastRejectedAt(h.signature)
      if (lastRej && Date.now() / 1000 - lastRej < policy.rejectCooldownSeconds) continue

      const targetFile = KIND_TARGET[h.kind] || 'AGENTS.md'
      const draft = `- When using **${h.tool || 'tool'}**: avoid repeating this failure — ${h.detail.slice(0, 200)}`
      const proposal: Proposal = {
        id: `prop_${crypto.randomUUID().slice(0, 8)}`,
        signature: h.signature,
        kind: h.kind,
        toolName: h.tool,
        targetFile,
        draft,
        rationale: `Recurring failure (${h.hits} hits): ${h.detail.slice(0, 150)}`,
        hits: h.hits,
        status: 'pending',
        createdAt: Date.now() / 1000,
      }
      this.proposals.set(proposal.id, proposal)
      created.push(proposal)
      if (open.length + created.length >= policy.maxOpen) break
    }

    if (created.length) this.save()
    return created
  }

  private hotSignatures(minHits: number): Array<{ signature: string; hits: number; tool: string; kind: string; detail: string }> {
    const counts = new Map<string, { hits: number; tool: string; kind: string; detail: string }>()
    for (const s of this.signals) {
      const e = counts.get(s.signature) || { hits: 0, tool: s.toolName, kind: s.kind, detail: s.detail }
      e.hits++
      counts.set(s.signature, e)
    }
    return Array.from(counts.entries())
      .filter(([, v]) => v.hits >= minHits)
      .map(([signature, v]) => ({ signature, ...v }))
      .sort((a, b) => b.hits - a.hits)
  }

  openProposals(): Proposal[] {
    return Array.from(this.proposals.values()).filter((p) => p.status === 'pending')
  }

  hasOpenForSignature(sig: string): boolean {
    return this.openProposals().some((p) => p.signature === sig)
  }

  lastRejectedAt(sig: string): number {
    let max = 0
    for (const p of this.proposals.values()) {
      if (p.signature === sig && p.status === 'rejected' && p.decidedAt) max = Math.max(max, p.decidedAt)
    }
    return max
  }

  accept(proposalId: string, workspaceRoot?: string): { ok: boolean; applied: boolean; error?: string } {
    const p = this.proposals.get(proposalId)
    if (!p || p.status !== 'pending') return { ok: false, applied: false, error: 'Proposal not found or already decided' }

    const root = workspaceRoot || this.workspaceRoot
    const targetPath = path.join(root, p.targetFile)
    let applied = false

    try {
      let content = ''
      if (fs.existsSync(targetPath)) content = fs.readFileSync(targetPath, 'utf-8')

      if (content.includes(EVOLUTION_HEADING)) {
        content = content.trimEnd() + '\n' + p.draft + '\n'
      } else {
        content = (content.trimEnd() ? content.trimEnd() + '\n\n' : '') + EVOLUTION_HEADING + '\n' + p.draft + '\n'
      }

      const dir = path.dirname(targetPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(targetPath, content, 'utf-8')
      applied = true
    } catch (e: any) {
      p.status = 'rejected'
      p.decidedAt = Date.now() / 1000
      p.applied = false
      this.save()
      return { ok: false, applied: false, error: e.message }
    }

    p.status = 'accepted'
    p.decidedAt = Date.now() / 1000
    p.applied = applied
    this.save()
    return { ok: true, applied }
  }

  reject(proposalId: string): { ok: boolean } {
    const p = this.proposals.get(proposalId)
    if (!p) return { ok: false }
    p.status = 'rejected'
    p.decidedAt = Date.now() / 1000
    p.applied = false
    this.save()
    return { ok: true }
  }

  getEvolvedRulesPrompt(workspaceRoot?: string): string {
    const root = workspaceRoot || this.workspaceRoot
    const parts: string[] = []
    for (const fname of ['AGENTS.md', 'MEMORY.md']) {
      const fp = path.join(root, fname)
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, 'utf-8')
        const idx = content.indexOf(EVOLUTION_HEADING)
        if (idx >= 0) parts.push(content.slice(idx))
      }
    }
    return parts.length ? '\n\n' + parts.join('\n\n') : ''
  }
}

// Singleton per config root
const instances = new Map<string, EvolutionService>()

export function getEvolutionService(configRoot: string, workspaceRoot: string): EvolutionService {
  const key = configRoot
  if (!instances.has(key)) instances.set(key, new EvolutionService(configRoot, workspaceRoot))
  return instances.get(key)!
}
