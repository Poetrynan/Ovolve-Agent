/**
 * OvolveCoreBridge.ts — High-Performance Execution & Indexing Bridge
 *
 * Provides TypeScript bridge matching Rust `crates/ovolve_core` signatures:
 * 1. Fast multiline string replace with smart auto-diagnosis fuzzy matching (`replaceFileContentFast`).
 * 2. Zero-copy spill stream filtering with Head-Tail preview (`generateSpillPreview`).
 * 3. Multilingual BM25 inverted index supporting CJK unigrams/bigrams and tag boosts (`Bm25Index`).
 */

export interface CandidateMatch {
  lineNumber: number
  preview: string
  similarity: number
}

export interface ReplaceResult {
  success: boolean
  matched: boolean
  content: string
  replacedCount: number
  error?: string
  diagnostics?: string
  candidates?: CandidateMatch[]
}

export interface SpillPreview {
  isSpilled: boolean
  totalLines: number
  totalChars: number
  previewContent: string
  headLines: number
  tailLines: number
  omittedLines: number
  spillFilePath?: string
}

export interface Bm25Doc {
  id: string
  tags: string[]
  content: string
}

export interface Bm25SearchResult {
  id: string
  score: number
  snippet: string
}

/**
 * Computes Levenshtein distance between two strings
 */
export function levenshteinDistance(s1: string, s2: string): number {
  const chars1 = Array.from(s1)
  const chars2 = Array.from(s2)
  const len1 = chars1.length
  const len2 = chars2.length

  if (len1 === 0) return len2
  if (len2 === 0) return len1

  const dp: number[][] = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0))

  for (let i = 0; i <= len1; i++) {
    dp[i][0] = i
  }
  for (let j = 0; j <= len2; j++) {
    dp[0][j] = j
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = chars1[i - 1] === chars2[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      )
    }
  }

  return dp[len1][len2]
}

/**
 * Computes normalized character similarity between target and candidate line
 */
export function computeSimilarity(s1: string, s2: string): number {
  const clean1 = s1.replace(/\s+/g, '')
  const clean2 = s2.replace(/\s+/g, '')

  if (!clean1 || !clean2) {
    return 0.0
  }
  if (clean1 === clean2) {
    return 1.0
  }
  if (clean1.includes(clean2) || clean2.includes(clean1)) {
    return 0.85
  }

  const len1 = Array.from(clean1).length
  const len2 = Array.from(clean2).length
  const maxLen = Math.max(len1, len2)
  if (maxLen === 0) {
    return 1.0
  }

  const dist = levenshteinDistance(clean1, clean2)
  return Math.max(0, 1.0 - dist / maxLen)
}

/**
 * Fast multiline replace with smart auto-diagnosis fuzzy matching
 */
export function replaceFileContentFast(
    originalText: string,
    targetContent: string,
    replacementContent: string,
    allowMultiple = false
): ReplaceResult {
  if (!originalText.includes(targetContent)) {
    // Auto-diagnosis: locate near matches for 1-step self-healing
    const lines = originalText.split(/\r?\n/)
    const targetFirstLine = (targetContent.split(/\r?\n/)[0] || '').trim()
    const candidates: CandidateMatch[] = []

    if (targetFirstLine) {
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx]
        const sim = computeSimilarity(targetFirstLine, line)
        if (sim >= 0.55) {
          const targetLineCount = targetContent.split(/\r?\n/).length
          const startCtx = Math.max(0, idx - 2)
          const endCtx = Math.min(lines.length, idx + targetLineCount + 2)
          const previewLines: string[] = []
          for (let i = startCtx; i < endCtx; i++) {
            const lineNum = (i + 1).toString().padStart(4, ' ')
            previewLines.push(`${lineNum} | ${lines[i]}`)
          }
          candidates.push({
            lineNumber: idx + 1,
            preview: previewLines.join('\n'),
            similarity: sim,
          })
          if (candidates.length >= 3) {
            break
          }
        }
      }
    }

    let diagnostics: string | undefined
    if (candidates.length > 0) {
      const hints = candidates
        .map((c) => `Near Line ${c.lineNumber} (similarity ${c.similarity.toFixed(2)}):\n${c.preview}`)
        .join('\n---\n')
      diagnostics = `💡 Auto-Diagnosis: target_content was not found exactly (check whitespace/indentation/typo). Found candidate line(s):\n${hints}\nPlease adjust target_content to match the exact lines above.`
    }

    return {
      success: false,
      matched: false,
      content: originalText,
      replacedCount: 0,
      error: 'Target content not found in original text',
      diagnostics,
      candidates: candidates.length > 0 ? candidates : undefined,
    }
  }

  // Count exact occurrences
  const count = originalText.split(targetContent).length - 1
  if (count > 1 && !allowMultiple) {
    return {
      success: false,
      matched: true,
      content: originalText,
      replacedCount: 0,
      error: `Found ${count} occurrences of targetContent but allow_multiple is false`,
      diagnostics: `Target content appears ${count} times; provide more surrounding context or set allow_multiple=true`,
    }
  }

  const newContent = allowMultiple
    ? originalText.split(targetContent).join(replacementContent)
    : originalText.replace(targetContent, replacementContent)

  const replacedCount = allowMultiple ? count : 1

  return {
    success: true,
    matched: true,
    content: newContent,
    replacedCount,
  }
}

/**
 * Zero-copy spill stream filtering with Head-Tail preview
 */
export function generateSpillPreview(
  rawOutput: string,
  thresholdChars = 16000,
  headLinesCount = 40,
  tailLinesCount = 40
): SpillPreview {
  const totalChars = rawOutput.length
  const lines = rawOutput.split(/\r?\n/)
  const totalLines = lines.length

  if (totalChars <= thresholdChars) {
    return {
      isSpilled: false,
      totalLines,
      totalChars,
      previewContent: rawOutput,
      headLines: totalLines,
      tailLines: 0,
      omittedLines: 0,
    }
  }

  if (totalLines <= headLinesCount + tailLinesCount) {
    return {
      isSpilled: true,
      totalLines,
      totalChars,
      previewContent: rawOutput,
      headLines: totalLines,
      tailLines: 0,
      omittedLines: 0,
    }
  }

  const headSlice = lines.slice(0, headLinesCount)
  const tailSlice = lines.slice(totalLines - tailLinesCount)
  const omittedLines = totalLines - headLinesCount - tailLinesCount

  const preview = [
    headSlice.join('\n'),
    `\n... [⚠️ Output Spilled: omitted ${omittedLines} lines (${totalChars} chars). Full log persisted to disk] ...\n`,
    tailSlice.join('\n'),
  ].join('\n')

  return {
    isSpilled: true,
    totalLines,
    totalChars,
    previewContent: preview,
    headLines: headLinesCount,
    tailLines: tailLinesCount,
    omittedLines,
  }
}

/**
 * Multilingual BM25 Inverted Index supporting English words, CJK unigrams/bigrams, and tag boosts
 */
export class Bm25Index {
  private docs: Bm25Doc[] = []
  private docLens: number[] = []
  private avgdl = 0.0
  private docFreqs: Map<string, number> = new Map()
  private k1: number
  private b: number

  constructor(docs: Bm25Doc[] = [], k1 = 1.5, b = 0.75) {
    this.k1 = k1
    this.b = b
    this.setDocs(docs)
  }

  public static tokenize(text: string): string[] {
    const tokens: string[] = []
    let currentWord = ''
    const chars = Array.from(text.toLowerCase())
    const cjkChars: string[] = []

    for (const c of chars) {
      // Check if ASCII alphanumeric
      if (/[a-z0-9_]/.test(c)) {
        if (cjkChars.length > 0) {
          cjkChars.length = 0
        }
        currentWord += c
      } else if (/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(c)) {
        // CJK character
        if (currentWord.length > 0) {
          tokens.push(currentWord)
          currentWord = ''
        }
        // Unigram
        tokens.push(c)
        cjkChars.push(c)
        // Bigram if previous character was also CJK
        if (cjkChars.length >= 2) {
          const len = cjkChars.length
          tokens.push(cjkChars[len - 2] + cjkChars[len - 1])
        }
      } else {
        if (currentWord.length > 0) {
          tokens.push(currentWord)
          currentWord = ''
        }
        cjkChars.length = 0
      }
    }

    if (currentWord.length > 0) {
      tokens.push(currentWord)
    }

    return tokens
  }

  public setDocs(docs: Bm25Doc[]): void {
    this.docs = [...docs]
    const n = this.docs.length
    if (n === 0) {
      this.docLens = []
      this.avgdl = 0.0
      this.docFreqs.clear()
      return
    }

    this.docLens = []
    let totalLen = 0
    this.docFreqs.clear()

    for (const doc of this.docs) {
      const tokens = Bm25Index.tokenize(doc.content)
      const len = tokens.length
      this.docLens.push(len)
      totalLen += len

      const uniqueTokens = new Set(tokens)
      for (const t of uniqueTokens) {
        this.docFreqs.set(t, (this.docFreqs.get(t) || 0) + 1)
      }
    }

    this.avgdl = totalLen / n
  }

  public addDoc(doc: Bm25Doc): void {
    this.docs.push(doc)
    this.setDocs(this.docs)
  }

  public getDocs(): Bm25Doc[] {
    return this.docs
  }

  public search(query: string, topK = 10): Bm25SearchResult[] {
    const n = this.docs.length
    if (n === 0) return []

    const qTokens = Bm25Index.tokenize(query)
    const scores: { idx: number; score: number }[] = []

    for (let idx = 0; idx < this.docs.length; idx++) {
      const doc = this.docs[idx]
      const docTokens = Bm25Index.tokenize(doc.content)
      const dl = this.docLens[idx]
      let score = 0.0

      const tfMap = new Map<string, number>()
      for (const t of docTokens) {
        tfMap.set(t, (tfMap.get(t) || 0) + 1)
      }

      for (const qt of qTokens) {
        const df = this.docFreqs.get(qt)
        if (df !== undefined && df > 0) {
          const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1.0)
          const tf = tfMap.get(qt) || 0
          const num = tf * (this.k1 + 1.0)
          const den = tf + this.k1 * (1.0 - this.b + this.b * (dl / (this.avgdl || 1.0)))
          score += idf * (num / den)
        }
      }

      // Tag match bonus (+2.0 per tag match in query)
      const queryLower = query.toLowerCase()
      for (const tag of doc.tags) {
        if (tag && queryLower.includes(tag.toLowerCase())) {
          score += 2.0
        }
      }

      if (score > 0.0) {
        scores.push({ idx, score })
      }
    }

    scores.sort((a, b) => b.score - a.score)
    const topScores = scores.slice(0, topK)

    return topScores.map(({ idx, score }) => {
      const doc = this.docs[idx]
      const snippet = Array.from(doc.content).slice(0, 200).join('')
      return {
        id: doc.id,
        score,
        snippet,
      }
    })
  }
}

export const OvolveCoreBridge = {
  levenshteinDistance,
  computeSimilarity,
  replaceFileContentFast,
  generateSpillPreview,
  Bm25Index,
}
