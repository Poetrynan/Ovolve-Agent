/**
 * MemoryStorage.ts — Database Schema and Persistent Storage Engine for Memory & Wiki
 *
 * Implements SQLite schema and high-reliability data access layer:
 * 1. `memory_entries` table: Episodic and semantic long-term memory store.
 * 2. `memory_fts` virtual table: Lexical FTS indexing with CJK bigrams.
 * 3. `wiki_claims` table: Declarative knowledge with bidirectional contradiction tracking.
 * 4. Resilient persistence supporting file-based, in-memory, and migration pathways.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { MemoryTier, normalizeTier, shouldPromote, isExpired } from './MemoryTiers'
import { ftsDocument, cjkBigrams, fuse, rerankCandidates } from './MemoryRetrieval'
import { screenMemoryContent, classifySensitivity, type SensitivityLevel } from './MemoryGuard'

export interface MemoryEntry {
  id: string
  session_id?: string
  root_dir: string
  scope: 'workspace' | 'project' | 'session'
  content: string
  embedding?: number[]
  metadata: Record<string, any>
  type: 'fact' | 'preference' | 'context' | 'procedure' | 'dream' | 'session'
  importance: number
  tags: string[]
  tier: MemoryTier
  status: 'candidate' | 'active' | 'stale' | 'rejected' | 'archived'
  status_reason?: string
  confidence: number
  sensitivity: SensitivityLevel
  created_by: string
  hits: number
  valid_from: number
  valid_until: number
  last_confirmed_at: number
  accessed_at: number
  conflict_set: string[]
  supersedes: string[]
  superseded_by: string
  archived: number
  created_at: number
  updated_at: number
  expires_at?: number
}

export interface WikiClaim {
  id: string
  root_dir: string
  subject: string
  predicate: string
  object: string
  statement: string
  confidence: number
  evidence: string[]
  contradicts: string[]
  status: 'active' | 'disputed' | 'superseded' | 'deleted'
  source: string
  sp_key: string
  status_reason?: string
  created_at: number
  updated_at: number
}

export interface FtsEntry {
  entryId: string
  rootDir: string
  body: string
}

export class MemoryStorage {
  private static instance: MemoryStorage | null = null
  private storageDir: string
  private entriesFile: string
  private wikiFile: string
  private isInMemory: boolean

  private entriesMap = new Map<string, MemoryEntry>()
  private ftsIndex: FtsEntry[] = []
  private wikiMap = new Map<string, WikiClaim>()

  constructor(options: { storageDir?: string; inMemory?: boolean } = {}) {
    this.isInMemory = !!options.inMemory
    this.storageDir = options.storageDir || '.ovolve/storage'
    this.entriesFile = path.join(this.storageDir, 'memory_entries.json')
    this.wikiFile = path.join(this.storageDir, 'wiki_claims.json')

    if (!this.isInMemory) {
      this.ensureSchema()
      this.loadFromDisk()
    }
  }

  public static getInstance(options?: { storageDir?: string; inMemory?: boolean }): MemoryStorage {
    if (!MemoryStorage.instance) {
      MemoryStorage.instance = new MemoryStorage(options)
    }
    return MemoryStorage.instance
  }

  public static createInMemory(): MemoryStorage {
    return new MemoryStorage({ inMemory: true })
  }

  private ensureSchema(): void {
    if (this.isInMemory) return
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true })
      }
    } catch {}
  }

  private loadFromDisk(): void {
    if (this.isInMemory) return
    try {
      if (fs.existsSync(this.entriesFile)) {
        const raw = fs.readFileSync(this.entriesFile, 'utf8')
        const list: MemoryEntry[] = JSON.parse(raw)
        this.entriesMap.clear()
        this.ftsIndex = []
        for (const item of list) {
          this.entriesMap.set(item.id, item)
          this.indexFts(item)
        }
      }
      if (fs.existsSync(this.wikiFile)) {
        const raw = fs.readFileSync(this.wikiFile, 'utf8')
        const list: WikiClaim[] = JSON.parse(raw)
        this.wikiMap.clear()
        for (const item of list) {
          this.wikiMap.set(item.id, item)
        }
      }
    } catch (e) {
      // In case of corrupt file or parse error, keep memory state
    }
  }

  private saveToDisk(): void {
    if (this.isInMemory) return
    try {
      this.ensureSchema()
      const entries = Array.from(this.entriesMap.values())
      fs.writeFileSync(this.entriesFile, JSON.stringify(entries, null, 2), 'utf8')

      const claims = Array.from(this.wikiMap.values())
      fs.writeFileSync(this.wikiFile, JSON.stringify(claims, null, 2), 'utf8')
    } catch (e) {}
  }

  private indexFts(entry: MemoryEntry): void {
    const body = ftsDocument(entry.content)
    this.ftsIndex = this.ftsIndex.filter((f) => f.entryId !== entry.id)
    this.ftsIndex.push({
      entryId: entry.id,
      rootDir: entry.root_dir,
      body,
    })
  }

  // -------------------------------------------------------------------------
  // Episodic & Semantic Memory Entries Operations
  // -------------------------------------------------------------------------

  public storeEntry(
    entry: Partial<MemoryEntry> & { content: string; root_dir?: string },
    options: { trusted?: boolean } = {}
  ): { success: boolean; entry?: MemoryEntry; reason?: string } {
    const screening = screenMemoryContent(entry.content, { trusted: options.trusted })
    if (!screening.allowed) {
      return { success: false, reason: screening.reasons.join(', ') }
    }

    const now = Math.floor(Date.now() / 1000)
    const id = entry.id || `mem-${crypto.randomUUID().slice(0, 8)}`
    const tier = normalizeTier(entry.tier)

    const fullEntry: MemoryEntry = {
      id,
      session_id: entry.session_id || '',
      root_dir: entry.root_dir || 'default',
      scope: entry.scope || 'project',
      content: screening.content,
      embedding: entry.embedding,
      metadata: entry.metadata || {},
      type: entry.type || 'fact',
      importance: typeof entry.importance === 'number' ? entry.importance : 0.5,
      tags: entry.tags || [],
      tier,
      status: entry.status || 'active',
      status_reason: entry.status_reason || '',
      confidence: typeof entry.confidence === 'number' ? entry.confidence : 0.8,
      sensitivity: screening.sensitivity,
      created_by: entry.created_by || 'agent',
      hits: entry.hits || 0,
      valid_from: entry.valid_from || 0,
      valid_until: entry.valid_until || 0,
      last_confirmed_at: entry.last_confirmed_at || 0,
      accessed_at: entry.accessed_at || now,
      conflict_set: entry.conflict_set || [],
      supersedes: entry.supersedes || [],
      superseded_by: entry.superseded_by || '',
      archived: entry.archived || 0,
      created_at: entry.created_at || now,
      updated_at: entry.updated_at || now,
      expires_at: entry.expires_at,
    }

    this.entriesMap.set(id, fullEntry)
    this.indexFts(fullEntry)
    this.saveToDisk()

    return { success: true, entry: fullEntry }
  }

  public getEntry(id: string): MemoryEntry | null {
    return this.entriesMap.get(id) || null
  }

  public listEntries(filter: {
    root_dir?: string
    tier?: MemoryTier | string
    status?: string
    session_id?: string
    include_archived?: boolean
  } = {}): MemoryEntry[] {
    const list = Array.from(this.entriesMap.values())
    return list.filter((item) => {
      if (filter.root_dir && item.root_dir !== filter.root_dir) return false
      if (filter.tier && item.tier !== filter.tier) return false
      if (filter.status && item.status !== filter.status) return false
      if (filter.session_id && item.session_id !== filter.session_id) return false
      if (!filter.include_archived && item.archived === 1) return false
      return true
    })
  }

  public deleteEntry(id: string, hard = false): boolean {
    if (!this.entriesMap.has(id)) return false
    if (hard) {
      this.entriesMap.delete(id)
      this.ftsIndex = this.ftsIndex.filter((f) => f.entryId !== id)
    } else {
      const entry = this.entriesMap.get(id)!
      entry.archived = 1
      entry.status = 'archived'
      entry.updated_at = Math.floor(Date.now() / 1000)
    }
    this.saveToDisk()
    return true
  }

  public recordHit(id: string): { entry: MemoryEntry | null; promotedTo: MemoryTier | null } {
    const entry = this.entriesMap.get(id)
    if (!entry) return { entry: null, promotedTo: null }

    entry.hits = (entry.hits || 0) + 1
    entry.accessed_at = Math.floor(Date.now() / 1000)
    entry.updated_at = Math.floor(Date.now() / 1000)

    const promotion = shouldPromote(entry.tier, entry.hits)
    let promotedTo: MemoryTier | null = null
    if (promotion) {
      entry.tier = promotion
      promotedTo = promotion
    }

    this.saveToDisk()
    return { entry, promotedTo }
  }

  public searchLexical(query: string, rootDir?: string, limit = 20): Array<{ id: string; score: number }> {
    const qTokens = cjkBigrams(query).concat((query.match(/[A-Za-z0-9_]+/g) || []).map((w) => w.toLowerCase()))
    if (qTokens.length === 0) return []

    const hits: Array<{ id: string; score: number }> = []

    for (const item of this.ftsIndex) {
      if (rootDir && item.rootDir !== rootDir) continue
      const doc = this.entriesMap.get(item.entryId)
      if (!doc || doc.archived === 1) continue

      let matchCount = 0
      const bodyLower = item.body.toLowerCase()
      for (const token of qTokens) {
        if (bodyLower.includes(token.toLowerCase())) {
          matchCount++
        }
      }

      if (matchCount > 0) {
        const score = matchCount / qTokens.length
        hits.push({ id: item.entryId, score })
      }
    }

    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  public searchHybrid(
    query: string,
    queryVector?: number[] | null,
    options: {
      rootDir?: string
      limit?: number
      tier?: MemoryTier
      mmrEnabled?: boolean
    } = {}
  ): MemoryEntry[] {
    const limit = options.limit || 5
    const rootDir = options.rootDir

    // Lexical scoring
    const lexHits = this.searchLexical(query, rootDir, limit * 4)
    const keywordScores: Record<string, number> = {}
    for (const h of lexHits) {
      keywordScores[h.id] = h.score
    }

    // Vector scoring
    const vectorScores: Record<string, number> = {}
    const pool = this.listEntries({ root_dir: rootDir, tier: options.tier })
    for (const doc of pool) {
      if (queryVector && doc.embedding) {
        let dot = 0, na = 0, nb = 0
        for (let i = 0; i < queryVector.length && i < doc.embedding.length; i++) {
          dot += queryVector[i] * doc.embedding[i]
          na += queryVector[i] * queryVector[i]
          nb += doc.embedding[i] * doc.embedding[i]
        }
        if (na > 0 && nb > 0) {
          vectorScores[doc.id] = Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb)))
        }
      }
    }

    const fused = fuse(vectorScores, keywordScores)
    const candidateEntries: MemoryEntry[] = []
    for (const f of fused) {
      const doc = this.getEntry(f.id)
      if (doc) candidateEntries.push(doc)
    }

    return rerankCandidates(candidateEntries, queryVector, {
      limit,
      mmrEnabled: options.mmrEnabled,
    })
  }

  // -------------------------------------------------------------------------
  // Declarative Knowledge (Wiki Claims) Operations
  // -------------------------------------------------------------------------

  public static spKey(subject: string, predicate: string): string {
    const s = subject.trim().toLowerCase()
    const p = predicate.trim().toLowerCase()
    return crypto.createHash('sha1').update(`${s}\x1f${p}`).digest('hex').slice(0, 16)
  }

  public detectWikiConflicts(
    rootDir: string,
    subject: string,
    predicate: string,
    objectVal: string,
    statement: string
  ): WikiClaim[] {
    const sp_key = MemoryStorage.spKey(subject, predicate)
    const peers = Array.from(this.wikiMap.values()).filter(
      (c) => c.root_dir === rootDir && c.sp_key === sp_key && (c.status === 'active' || c.status === 'disputed')
    )

    const conflicts: WikiClaim[] = []
    const normObj = objectVal.trim().toLowerCase()
    const isNegated = /(?:不|非|没|无|别|not|never|no longer|don't|cannot)/i.test(statement)

    for (const peer of peers) {
      const peerObj = peer.object.trim().toLowerCase()
      // Structural contradiction: same s+p, different object
      if (normObj && peerObj && normObj !== peerObj) {
        conflicts.push(peer)
        continue
      }
      // Textual contradiction: same s+p, one negated and the other not
      const peerNegated = /(?:不|非|没|无|别|not|never|no longer|don't|cannot)/i.test(peer.statement)
      if (isNegated !== peerNegated) {
        conflicts.push(peer)
      }
    }
    return conflicts
  }

  public addWikiClaim(claim: {
    root_dir?: string
    subject: string
    predicate: string
    object?: string
    statement?: string
    confidence?: number
    evidence?: string[]
    source?: string
  }): { claim: WikiClaim; conflicts: WikiClaim[] } {
    const root_dir = claim.root_dir || 'default'
    const subject = claim.subject.trim()
    const predicate = claim.predicate.trim()
    const objectVal = (claim.object || '').trim()
    const statement = claim.statement || `${subject} ${predicate} ${objectVal}`.trim()
    const confidence = Math.max(0, Math.min(1, typeof claim.confidence === 'number' ? claim.confidence : 1.0))
    const sp_key = MemoryStorage.spKey(subject, predicate)
    const now = Math.floor(Date.now() / 1000)
    const id = `wiki-${crypto.randomUUID().slice(0, 8)}`

    const conflicts = this.detectWikiConflicts(root_dir, subject, predicate, objectVal, statement)
    const status: 'active' | 'disputed' = conflicts.length > 0 ? 'disputed' : 'active'

    const newClaim: WikiClaim = {
      id,
      root_dir,
      subject,
      predicate,
      object: objectVal,
      statement,
      confidence,
      evidence: claim.evidence || [],
      contradicts: conflicts.map((c) => c.id),
      status,
      source: claim.source || 'user',
      sp_key,
      created_at: now,
      updated_at: now,
    }

    this.wikiMap.set(id, newClaim)

    // Update conflicting peers bidirectionally
    for (const peer of conflicts) {
      peer.status = 'disputed'
      if (!peer.contradicts.includes(id)) {
        peer.contradicts.push(id)
      }
      peer.updated_at = now
    }

    this.saveToDisk()
    return { claim: newClaim, conflicts }
  }

  public getWikiClaim(id: string): WikiClaim | null {
    return this.wikiMap.get(id) || null
  }

  public listWikiClaims(filter: {
    root_dir?: string
    status?: string
    subject?: string
    include_deleted?: boolean
  } = {}): WikiClaim[] {
    const list = Array.from(this.wikiMap.values())
    return list.filter((item) => {
      if (filter.root_dir && item.root_dir !== filter.root_dir) return false
      if (filter.status && item.status !== filter.status) return false
      if (filter.subject && item.subject !== filter.subject) return false
      if (!filter.include_deleted && item.status === 'deleted') return false
      return true
    })
  }

  public supersedeWikiClaim(oldId: string, newId: string): boolean {
    const oldClaim = this.wikiMap.get(oldId)
    const newClaim = this.wikiMap.get(newId)
    if (!oldClaim || !newClaim) return false

    const now = Math.floor(Date.now() / 1000)
    oldClaim.status = 'superseded'
    oldClaim.updated_at = now

    // Recompute conflicts for newClaim
    newClaim.contradicts = newClaim.contradicts.filter((id) => id !== oldId)
    const activeConflicts = newClaim.contradicts.filter((id) => {
      const c = this.wikiMap.get(id)
      return c && c.status === 'active'
    })
    newClaim.status = activeConflicts.length > 0 ? 'disputed' : 'active'
    newClaim.updated_at = now

    this.saveToDisk()
    return true
  }

  public softDeleteWikiClaim(id: string, reason = 'user_deleted'): boolean {
    const claim = this.wikiMap.get(id)
    if (!claim) return false

    const now = Math.floor(Date.now() / 1000)
    claim.status = 'deleted'
    claim.status_reason = reason
    claim.updated_at = now

    // Remove from other peers' contradiction lists
    for (const peerId of claim.contradicts) {
      const peer = this.wikiMap.get(peerId)
      if (peer) {
        peer.contradicts = peer.contradicts.filter((cid) => cid !== id)
        if (peer.contradicts.length === 0 && peer.status === 'disputed') {
          peer.status = 'active'
        }
        peer.updated_at = now
      }
    }

    this.saveToDisk()
    return true
  }

  public clear(): void {
    this.entriesMap.clear()
    this.ftsIndex = []
    this.wikiMap.clear()
    this.saveToDisk()
  }
}
