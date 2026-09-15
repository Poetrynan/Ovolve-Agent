export interface MemoryDoc {
  id: string
  tags: string[]
  content: string
  category: 'preference' | 'fact' | 'rule' | 'decision'
  createdAt: number
}

export class Bm25SearchIndex {
  private docs: MemoryDoc[] = []
  private k1: number
  private b: number

  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1
    this.b = b
  }

  public setDocs(docs: MemoryDoc[]): void {
    this.docs = docs
  }

  public addDoc(doc: MemoryDoc): void {
    this.docs.push(doc)
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-zA-Z0-9_\u4e00-\u9fa5]+/)
      .filter((s) => s.length > 0)
  }

  public search(query: string, topK = 5): { doc: MemoryDoc; score: number }[] {
    const N = this.docs.length
    if (N === 0) return []

    const qTokens = this.tokenize(query)
    if (qTokens.length === 0) return []

    const docLengths = this.docs.map((d) => this.tokenize(d.content).length)
    const avgdl = docLengths.reduce((a, b) => a + b, 0) / N || 1

    // Document frequencies
    const dfMap = new Map<string, number>()
    for (const doc of this.docs) {
      const unique = new Set(this.tokenize(doc.content))
      for (const t of unique) {
        dfMap.set(t, (dfMap.get(t) || 0) + 1)
      }
    }

    const scored: { doc: MemoryDoc; score: number }[] = []

    for (let i = 0; i < N; i++) {
      const doc = this.docs[i]
      const docTokens = this.tokenize(doc.content)
      const dl = docLengths[i]

      // Term frequencies in current doc
      const tfMap = new Map<string, number>()
      for (const t of docTokens) {
        tfMap.set(t, (tfMap.get(t) || 0) + 1)
      }

      let score = 0
      for (const qt of qTokens) {
        const df = dfMap.get(qt) || 0
        if (df > 0) {
          const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1.0)
          const tf = tfMap.get(qt) || 0
          const num = tf * (this.k1 + 1.0)
          const den = tf + this.k1 * (1.0 - this.b + this.b * (dl / avgdl))
          score += idf * (num / den)
        }
      }

      // Tag bonus
      const qLower = query.toLowerCase()
      for (const tag of doc.tags) {
        if (qLower.includes(tag.toLowerCase())) {
          score += 2.5
        }
      }

      if (score > 0) {
        scored.push({ doc, score })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }
}
