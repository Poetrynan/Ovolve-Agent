import type { MemoryDoc } from './bm25Index'

export interface ExtractionResult {
  preferences: string[]
  facts: string[]
  decisions: string[]
}

export class PreCompactionFlush {
  private flushThresholdRatio: number

  constructor(flushThresholdRatio = 0.75) {
    this.flushThresholdRatio = flushThresholdRatio
  }

  public shouldFlush(currentTokens: number, maxTokens: number): boolean {
    return currentTokens >= maxTokens * this.flushThresholdRatio
  }

  /**
   * High-precision heuristic fact and preference extractor from conversation history
   */
  public extractMemoryItems(messages: { role: string; content: string }[]): ExtractionResult {
    const preferences: string[] = []
    const facts: string[] = []
    const decisions: string[] = []

    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = msg.content
        // Preference detection
        if (/(prefer|always use|never use|don't use|must use|喜欢|必须用|不要用|禁止)/i.test(text)) {
          preferences.push(text.trim())
        }
        // Fact & configuration detection
        if (/(port|database|endpoint|config|api_key|端口|数据库|路径|地址|配置)/i.test(text)) {
          facts.push(text.trim())
        }
      } else if (msg.role === 'assistant') {
        const text = msg.content
        if (/(we decided|agreed upon|selected|决定采用|最终方案|达成一致)/i.test(text)) {
          const lines = text.split('\n').filter((l) => l.includes('决定') || l.includes('方案') || l.includes('decide'))
          decisions.push(...lines)
        }
      }
    }

    return {
      preferences: Array.from(new Set(preferences)),
      facts: Array.from(new Set(facts)),
      decisions: Array.from(new Set(decisions)),
    }
  }

  public toMemoryDocs(extraction: ExtractionResult, sessionId: string): MemoryDoc[] {
    const docs: MemoryDoc[] = []
    const now = Date.now()

    extraction.preferences.forEach((p, idx) => {
      docs.push({
        id: `pref-${sessionId}-${idx}-${now}`,
        category: 'preference',
        tags: ['user_preference', 'rule', sessionId],
        content: p,
        createdAt: now,
      })
    })

    extraction.facts.forEach((f, idx) => {
      docs.push({
        id: `fact-${sessionId}-${idx}-${now}`,
        category: 'fact',
        tags: ['project_fact', sessionId],
        content: f,
        createdAt: now,
      })
    })

    extraction.decisions.forEach((d, idx) => {
      docs.push({
        id: `dec-${sessionId}-${idx}-${now}`,
        category: 'decision',
        tags: ['architecture_decision', sessionId],
        content: d,
        createdAt: now,
      })
    })

    return docs
  }
}
