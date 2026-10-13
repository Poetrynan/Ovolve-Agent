import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export type MemoryTier = 'working' | 'short-term-recall' | 'long-term' | 'semantic' | 'wiki' | 'dreaming'

export interface MemoryEntry {
  id: string
  root_dir: string
  session_id?: string
  content: string
  tier: MemoryTier
  type: 'fact' | 'preference' | 'context' | 'procedure' | 'dream' | 'session'
  importance: number
  confidence: number
  status: 'candidate' | 'active' | 'stale' | 'rejected' | 'archived'
  hits: number
  tags: string[]
  created_at: number
  updated_at: number
  accessed_at: number
  expires_at?: number
  archived: number
}

export interface WikiClaim {
  id: string
  root_dir: string
  subject: string
  predicate: string
  object: string
  statement: string
  confidence: number
  status: 'active' | 'disputed' | 'superseded' | 'deleted'
  created_at: number
  updated_at: number
}

const TIER_POLICIES: Record<MemoryTier, { tokenBudget: number; alwaysInject: boolean; trust: number; ttlSeconds: number; promoteAfterHits: number; promoteTo?: MemoryTier }> = {
  working: { tokenBudget: 600, alwaysInject: true, trust: 0.9, ttlSeconds: 0, promoteAfterHits: 2, promoteTo: 'short-term-recall' },
  'short-term-recall': { tokenBudget: 0, alwaysInject: false, trust: 0.85, ttlSeconds: 43200, promoteAfterHits: 3, promoteTo: 'semantic' },
  'long-term': { tokenBudget: 2500, alwaysInject: true, trust: 1.0, ttlSeconds: 0, promoteAfterHits: 0 },
  semantic: { tokenBudget: 0, alwaysInject: false, trust: 0.8, ttlSeconds: 0, promoteAfterHits: 8, promoteTo: 'long-term' },
  wiki: { tokenBudget: 0, alwaysInject: false, trust: 0.9, ttlSeconds: 0, promoteAfterHits: 0 },
  dreaming: { tokenBudget: 0, alwaysInject: false, trust: 0.55, ttlSeconds: 2592000, promoteAfterHits: 5, promoteTo: 'semantic' },
}

function cjkBigrams(text: string): string[] {
  const tokens: string[] = []
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) tokens.push(ch)
  }
  return tokens
}

function tokenize(text: string): string[] {
  return [...cjkBigrams(text), ...(text.match(/[A-Za-z0-9_]+/g) || []).map((w) => w.toLowerCase())]
}

export class MemoryService {
  private entries = new Map<string, MemoryEntry>()
  private wikiClaims = new Map<string, WikiClaim>()
  private dataDir: string
  private lastActivity = Date.now()

  constructor(configRoot: string) {
    this.dataDir = path.join(configRoot, 'memory')
    this.load()
  }

  private entriesFile() { return path.join(this.dataDir, 'entries.json') }
  private wikiFile() { return path.join(this.dataDir, 'wiki.json') }

  private load(): void {
    try {
      if (fs.existsSync(this.entriesFile())) {
        for (const e of JSON.parse(fs.readFileSync(this.entriesFile(), 'utf-8'))) {
          this.entries.set(e.id, e)
        }
      }
      if (fs.existsSync(this.wikiFile())) {
        for (const c of JSON.parse(fs.readFileSync(this.wikiFile(), 'utf-8'))) {
          this.wikiClaims.set(c.id, c)
        }
      }
    } catch {}
  }

  private save(): void {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(this.entriesFile(), JSON.stringify(Array.from(this.entries.values()), null, 2))
    fs.writeFileSync(this.wikiFile(), JSON.stringify(Array.from(this.wikiClaims.values()), null, 2))
  }

  touch(): void { this.lastActivity = Date.now() }

  store(rootDir: string, entry: Partial<MemoryEntry> & { content: string }): MemoryEntry {
    const now = Math.floor(Date.now() / 1000)
    const full: MemoryEntry = {
      id: entry.id || `mem_${crypto.randomUUID().slice(0, 8)}`,
      root_dir: rootDir,
      session_id: entry.session_id,
      content: entry.content,
      tier: entry.tier || 'semantic',
      type: entry.type || 'fact',
      importance: entry.importance ?? 0.7,
      confidence: entry.confidence ?? 0.8,
      status: entry.status || 'active',
      hits: entry.hits || 0,
      tags: entry.tags || [],
      created_at: entry.created_at || now,
      updated_at: now,
      accessed_at: now,
      expires_at: entry.expires_at,
      archived: 0,
    }
    this.entries.set(full.id, full)
    this.save()
    return full
  }

  list(rootDir: string, tier?: MemoryTier): MemoryEntry[] {
    return Array.from(this.entries.values()).filter((e) =>
      e.root_dir === rootDir && e.archived === 0 && (!tier || e.tier === tier)
    )
  }

  recall(rootDir: string, query: string, topK = 5): MemoryEntry[] {
    const qTokens = tokenize(query)
    if (!qTokens.length) return []

    const scored: Array<{ entry: MemoryEntry; score: number }> = []
    const now = Date.now() / 1000

    for (const entry of this.entries.values()) {
      if (entry.root_dir !== rootDir || entry.archived) continue
      if (entry.expires_at && entry.expires_at < now) continue

      const body = entry.content.toLowerCase()
      let matches = 0
      for (const t of qTokens) {
        if (body.includes(t)) matches++
      }
      if (matches === 0) continue

      const policy = TIER_POLICIES[entry.tier]
      const decay = entry.updated_at ? Math.exp(-0.693 * (now - entry.updated_at) / (30 * 86400)) : 1
      const score = (matches / qTokens.length) * entry.importance * policy.trust * decay
      scored.push({ entry, score })
    }

    scored.sort((a, b) => b.score - a.score)
    const results = scored.slice(0, topK).map((s) => {
      s.entry.hits++
      s.entry.accessed_at = now
      const policy = TIER_POLICIES[s.entry.tier]
      if (policy.promoteTo && s.entry.hits >= policy.promoteAfterHits) {
        s.entry.tier = policy.promoteTo
      }
      return s.entry
    })
    if (results.length) this.save()
    return results
  }

  buildInjection(rootDir: string, sessionId: string): string {
    const parts: string[] = []
    const now = Date.now() / 1000

    // Always-inject tiers
    for (const tier of ['working', 'long-term'] as MemoryTier[]) {
      const policy = TIER_POLICIES[tier]
      const entries = this.list(rootDir, tier).filter((e) => e.status === 'active')
      if (!entries.length) continue
      let budget = policy.tokenBudget
      const lines: string[] = []
      for (const e of entries) {
        const approx = Math.ceil(e.content.length / 4)
        if (budget > 0 && approx > budget) break
        lines.push(`- [${e.type}] ${e.content}`)
        if (budget > 0) budget -= approx
      }
      if (lines.length) parts.push(`### ${tier} memory\n${lines.join('\n')}`)
    }

    // Wiki claims
    const claims = Array.from(this.wikiClaims.values()).filter(
      (c) => c.root_dir === rootDir && c.status === 'active'
    )
    if (claims.length) {
      parts.push('### Wiki Claims\n' + claims.map((c) => `- ${c.statement} (confidence: ${c.confidence})`).join('\n'))
    }

    return parts.length ? `<memory-context trust="curated">\n${parts.join('\n\n')}\n</memory-context>` : ''
  }

  async dreamConsolidate(rootDir: string): Promise<{ candidates: MemoryEntry[] }> {
    const idle = Date.now() - this.lastActivity > 5 * 60 * 1000
    if (!idle) return { candidates: [] }

    const recent = this.list(rootDir).filter((e) => {
      const age = Date.now() / 1000 - e.created_at
      return age < 86400 && e.tier !== 'dreaming' && e.status === 'active'
    })

    if (recent.length < 3) return { candidates: [] }

    const summary = recent.slice(0, 10).map((e) => e.content).join('; ')
    const candidate = this.store(rootDir, {
      content: `[Dream consolidation] ${summary.slice(0, 500)}`,
      tier: 'dreaming',
      type: 'dream',
      status: 'candidate',
      importance: 0.6,
      confidence: 0.55,
      expires_at: Math.floor(Date.now() / 1000) + 2592000,
    })

    return { candidates: [candidate] }
  }

  diagnostics(rootDir: string) {
    const entries = this.list(rootDir)
    const byTier: Record<string, number> = {}
    for (const e of entries) byTier[e.tier] = (byTier[e.tier] || 0) + 1
    return { total: entries.length, byTier, wikiClaims: this.wikiClaims.size }
  }

  flushForCompaction(rootDir: string, sessionId: string, messages: Array<{ role: string; content: string }>): number {
    let stored = 0
    for (const msg of messages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') continue
      const content = msg.content || ''
      const prefMatch = content.match(/(?:remember|prefer|always|never)\s+(.{10,200})/i)
      if (prefMatch) {
        this.store(rootDir, { content: prefMatch[1], tier: 'short-term-recall', type: 'preference', session_id: sessionId })
        stored++
      }
    }
    return stored
  }
}

const instances = new Map<string, MemoryService>()

export function getMemoryService(configRoot: string): MemoryService {
  if (!instances.has(configRoot)) instances.set(configRoot, new MemoryService(configRoot))
  return instances.get(configRoot)!
}
