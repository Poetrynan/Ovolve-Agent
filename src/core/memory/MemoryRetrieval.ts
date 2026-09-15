/**
 * MemoryRetrieval.ts — Hybrid Dense & Lexical Retrieval with CJK Bigrams and MMR Re-ranking
 *
 * Implements C2 hybrid retrieval architecture:
 * 1. CJK Character Bigram Tokenizer (cjkBigrams) for SQLite FTS5 & lexical indexing.
 * 2. Sentence-aware overlapping chunking (400 tokens / 80 token overlap).
 * 3. Min-Max Score Normalization & Weighted Fusion (0.7 vector + 0.3 lexical).
 * 4. Recency Time Decay (30-day half-life).
 * 5. Maximal Marginal Relevance (MMR, lambda=0.7) diversity re-ranking.
 */

import { estimateTokens } from './MemoryTiers'

export const VECTOR_WEIGHT = 0.7
export const KEYWORD_WEIGHT = 0.3
export const OVERSAMPLE = 4
export const CHUNK_TOKENS = 400
export const CHUNK_OVERLAP_TOKENS = 80
export const MIN_FUSED_SCORE = 0.02
export const RECALL_HALFLIFE_DAYS = 30.0
export const RECALL_MMR_LAMBDA = 0.7

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g
const WORD_RE = /[A-Za-z0-9_]+/g
const FTS_SPECIAL = new Set(['"', '*', '(', ')', ':', '^', '-', '+', ','])

export function isCJK(ch: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(ch)
}

/**
 * Generate overlapping character bigrams for each CJK run in text
 * Single-character runs yield themselves; runs of len >= 2 yield len-1 bigrams.
 */
export function cjkBigrams(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  const matches = text.match(CJK_RE)
  if (!matches) return []

  for (const run of matches) {
    if (run.length === 1) {
      out.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) {
      out.push(run.slice(i, i + 2))
    }
  }
  return out
}

/**
 * Render text into FTS5 token soup with lowercased ASCII words and CJK bigrams
 */
export function ftsDocument(text: string): string {
  if (!text) return ''
  const words = (text.match(WORD_RE) || []).map((w) => w.toLowerCase())
  const bigrams = cjkBigrams(text)
  return [...words, ...bigrams].join(' ')
}

export function sanitizeTerm(term: string): string {
  return Array.from(term || '')
    .filter((ch) => !FTS_SPECIAL.has(ch))
    .join('')
    .trim()
}

/**
 * Build an FTS5 MATCH expression from query text plus optional keywords
 */
export function buildFtsQuery(text: string, keywords: string[] = []): string {
  const terms: string[] = []
  const words = (text || '').match(WORD_RE) || []
  for (const w of words) {
    if (w.length > 1) {
      terms.push(w.toLowerCase())
    }
  }
  terms.push(...cjkBigrams(text || ''))

  for (const kw of keywords) {
    const cleaned = sanitizeTerm(String(kw))
    if (cleaned.length > 1) {
      terms.push(cleaned.toLowerCase())
    }
  }

  const seen = new Set<string>()
  const quoted: string[] = []
  for (const t of terms) {
    const sanitized = sanitizeTerm(t)
    if (!sanitized || seen.has(sanitized)) continue
    seen.add(sanitized)
    quoted.push(`"${sanitized}"`)
  }

  return quoted.join(' OR ')
}

// ---------------------------------------------------------------------------
// Sentence Boundary & Text Chunking
// ---------------------------------------------------------------------------

const SENTENCE_END = /(?<=[。！？；\n])|(?<=[.!?;])(?=\s)/

export function splitSentences(text: string): string[] {
  if (!text) return []
  const parts = text.split(SENTENCE_END).filter((p) => p && p.length > 0)
  return parts.length > 0 ? parts : [text]
}

export interface TextChunk {
  index: number
  text: string
  tokens: number
  start: number
}

export function chunkText(
  text: string,
  chunkTokens: number = CHUNK_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS
): TextChunk[] {
  if (!text || !text.trim()) return []
  const total = estimateTokens(text)
  if (total <= chunkTokens) {
    return [{ index: 0, text, tokens: total, start: 0 }]
  }

  const sentences = splitSentences(text)
  const chunks: TextChunk[] = []
  let buf: string[] = []
  let bufTokens = 0
  let cursor = 0
  let consumed = 0

  const flush = () => {
    if (buf.length === 0) return
    const body = buf.join('')
    chunks.push({
      index: chunks.length,
      text: body,
      tokens: bufTokens,
      start: cursor,
    })

    const tail: string[] = []
    let tailTokens = 0
    for (let i = buf.length - 1; i >= 0; i--) {
      const s = buf[i]
      const t = estimateTokens(s)
      if (tailTokens + t > overlapTokens && tail.length > 0) {
        break
      }
      tail.unshift(s)
      tailTokens += t
    }

    cursor = consumed - tail.join('').length
    buf = [...tail]
    bufTokens = tailTokens
  }

  for (const sent of sentences) {
    const st = estimateTokens(sent)
    if (buf.length > 0 && bufTokens + st > chunkTokens) {
      flush()
    }
    buf.push(sent)
    bufTokens += st
    consumed += sent.length
    if (bufTokens >= chunkTokens) {
      flush()
    }
  }

  if (buf.length > 0) {
    const body = buf.join('')
    if (chunks.length === 0 || !chunks[chunks.length - 1].text.includes(body)) {
      chunks.push({
        index: chunks.length,
        text: body,
        tokens: bufTokens,
        start: cursor,
      })
    }
  }

  return chunks
}

// ---------------------------------------------------------------------------
// Score Normalization & Fusion
// ---------------------------------------------------------------------------

export function normalizeScores(
  scores: Record<string, number>,
  higherIsBetter = true
): Record<string, number> {
  const keys = Object.keys(scores)
  if (keys.length === 0) return {}
  const vals = Object.values(scores)
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)

  if (Math.abs(hi - lo) < 1e-9) {
    const out: Record<string, number> = {}
    for (const k of keys) out[k] = 1.0
    return out
  }

  const span = hi - lo
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(scores)) {
    out[k] = higherIsBetter ? (v - lo) / span : (hi - v) / span
  }
  return out
}

export interface FusedResult {
  id: string
  score: number
  parts: { vec: number; kw: number }
}

export function fuse(
  vectorScores: Record<string, number>,
  keywordScores: Record<string, number>,
  vectorWeight: number = VECTOR_WEIGHT,
  keywordWeight: number = KEYWORD_WEIGHT
): FusedResult[] {
  const nv = normalizeScores(vectorScores, true)
  const nk = normalizeScores(keywordScores, true)

  let wv = vectorWeight
  let wk = keywordWeight

  const vKeys = Object.keys(nv)
  const kKeys = Object.keys(nk)

  if (vKeys.length === 0 && kKeys.length === 0) return []
  if (vKeys.length === 0) {
    wv = 0.0
    wk = 1.0
  } else if (kKeys.length === 0) {
    wv = 1.0
    wk = 0.0
  } else {
    const total = wv + wk
    if (total > 0) {
      wv = wv / total
      wk = wk / total
    }
  }

  const allKeys = new Set([...vKeys, ...kKeys])
  const out: FusedResult[] = []

  for (const key of allKeys) {
    const v = nv[key] || 0.0
    const k = nk[key] || 0.0
    const score = wv * v + wk * k
    out.push({
      id: key,
      score,
      parts: { vec: v, kw: k },
    })
  }

  out.sort((a, b) => b.score - a.score)
  return out
}

// ---------------------------------------------------------------------------
// Recency Decay & MMR Diversity Re-ranking
// ---------------------------------------------------------------------------

export function decayWeight(
  lastTouch: number,
  now?: number,
  halflifeDays: number = RECALL_HALFLIFE_DAYS
): number {
  if (!lastTouch) return 1.0
  const current = now !== undefined ? now : Date.now() / 1000
  const touchSec = lastTouch > 1e11 ? lastTouch / 1000 : lastTouch
  const ageDays = Math.max(0.0, (current - touchSec) / 86400.0)
  return Math.pow(0.5, ageDays / halflifeDays)
}

export function cosineSimilarity(a?: number[] | null, b?: number[] | null): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0.0
  let dot = 0.0
  let na = 0.0
  let nb = 0.0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0.0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface RetrievalCandidate {
  id: string
  content: string
  embedding?: number[]
  importance?: number
  confidence?: number
  updated_at?: number
  created_at?: number
  accessed_at?: number
  [key: string]: any
}

export function rerankCandidates<T extends RetrievalCandidate>(
  rows: T[],
  queryVector?: number[] | null,
  options: {
    limit?: number
    mmrEnabled?: boolean
    mmrLambda?: number
    decayEnabled?: boolean
    halflifeDays?: number
    now?: number
  } = {}
): T[] {
  if (!rows || rows.length === 0) return []
  const limit = options.limit || 10
  const mmrEnabled = options.mmrEnabled ?? true
  const mmrLambda = options.mmrLambda ?? RECALL_MMR_LAMBDA
  const decayEnabled = options.decayEnabled ?? true
  const halflifeDays = options.halflifeDays || RECALL_HALFLIFE_DAYS
  const current = options.now !== undefined ? options.now : Date.now() / 1000

  const n = rows.length
  const scored = rows.map((row, i) => {
    const vec = row.embedding || null
    let relevance: number
    if (queryVector && vec) {
      relevance = Math.max(0.0, cosineSimilarity(queryVector, vec))
    } else {
      relevance = 1.0 - i / Math.max(1, n)
    }

    const importance = typeof row.importance === 'number' ? row.importance : 0.5
    const confidence = typeof row.confidence === 'number' ? row.confidence : 0.8
    const touch = Math.max(
      Number(row.updated_at || row.updatedAt || 0),
      Number(row.accessed_at || row.accessedAt || 0),
      Number(row.created_at || row.createdAt || 0)
    )

    const decay = decayEnabled ? decayWeight(touch, current, halflifeDays) : 1.0
    const baseScore = relevance * (0.5 + importance) * confidence * decay

    return {
      row,
      vec,
      relevance,
      score: baseScore,
    }
  })

  scored.sort((a, b) => b.score - a.score)

  if (!mmrEnabled || limit >= scored.length) {
    return scored.slice(0, limit).map((s) => s.row)
  }

  const selected: typeof scored = []
  const pool = [...scored]

  while (pool.length > 0 && selected.length < limit) {
    let bestCandidate: (typeof scored)[0] | null = null
    let bestVal = -Infinity

    for (const cand of pool) {
      let redundancy = 0.0
      if (selected.length > 0 && cand.vec) {
        const simList = selected
          .filter((s) => s.vec)
          .map((s) => cosineSimilarity(cand.vec, s.vec))
        if (simList.length > 0) {
          redundancy = Math.max(...simList)
        }
      }

      const val = mmrLambda * cand.score - (1.0 - mmrLambda) * redundancy
      if (val > bestVal) {
        bestVal = val
        bestCandidate = cand
      }
    }

    if (!bestCandidate) break
    selected.push(bestCandidate)
    const idx = pool.indexOf(bestCandidate)
    if (idx >= 0) pool.splice(idx, 1)
  }

  return selected.map((s) => s.row)
}
