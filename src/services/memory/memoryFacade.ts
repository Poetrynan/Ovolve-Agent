import fs from 'node:fs'
import path from 'node:path'
import { Bm25SearchIndex, type MemoryDoc } from './bm25Index'
import { PreCompactionFlush } from './preCompaction'

export class MemoryFacade {
  private static instance: MemoryFacade
  private searchIndex: Bm25SearchIndex
  private preCompaction: PreCompactionFlush
  private storagePath: string
  private docs: MemoryDoc[] = []

  constructor(storagePath = '.ovolve/memory.json') {
    this.storagePath = storagePath
    this.searchIndex = new Bm25SearchIndex()
    this.preCompaction = new PreCompactionFlush()
    this.loadFromDisk()
  }

  public static getInstance(): MemoryFacade {
    if (!MemoryFacade.instance) {
      MemoryFacade.instance = new MemoryFacade()
    }
    return MemoryFacade.instance
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8')
        this.docs = JSON.parse(raw)
        this.searchIndex.setDocs(this.docs)
      }
    } catch (e) {
      this.docs = []
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.storagePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(this.storagePath, JSON.stringify(this.docs, null, 2), 'utf8')
      this.searchIndex.setDocs(this.docs)
    } catch (e) {}
  }

  public addDoc(doc: Omit<MemoryDoc, 'id' | 'createdAt'>): MemoryDoc {
    const fullDoc: MemoryDoc = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      ...doc,
    }
    this.docs.push(fullDoc)
    this.saveToDisk()
    return fullDoc
  }

  public queryContext(query: string, topK = 5): string {
    const results = this.searchIndex.search(query, topK)
    if (results.length === 0) return ''

    const lines = results.map((r) => `- [${r.doc.category.toUpperCase()}] ${r.doc.content}`)
    return `【OvolveAgent 长期记忆上下文】:\n${lines.join('\n')}`
  }

  public handlePreCompaction(
    sessionId: string,
    messages: { role: string; content: string }[],
    currentTokens: number,
    maxTokens: number
  ): boolean {
    if (!this.preCompaction.shouldFlush(currentTokens, maxTokens)) {
      return false
    }

    const extracted = this.preCompaction.extractMemoryItems(messages)
    const newDocs = this.preCompaction.toMemoryDocs(extracted, sessionId)

    if (newDocs.length > 0) {
      this.docs.push(...newDocs)
      this.saveToDisk()
      return true
    }

    return false
  }

  public getAllDocs(): MemoryDoc[] {
    return [...this.docs]
  }

  public clear(): void {
    this.docs = []
    this.saveToDisk()
  }
}
