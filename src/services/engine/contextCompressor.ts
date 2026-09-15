import type { Message } from '../../types/agent'
import { MemoryFacade } from '../memory/memoryFacade'

export interface CompressionResult {
  isCompressed: boolean
  compressedMessages: Message[]
  flushedFactsCount: number
  estimatedTokens: number
}

export class ContextCompressor {
  private maxTokens: number
  private preserveRecentCount: number
  private memoryFacade: MemoryFacade

  constructor(maxTokens = 64000, preserveRecentCount = 6) {
    this.maxTokens = maxTokens
    this.preserveRecentCount = preserveRecentCount
    this.memoryFacade = MemoryFacade.getInstance()
  }

  public estimateTokens(messages: Message[], systemPrompt = ''): number {
    let totalChars = systemPrompt.length
    for (const m of messages) {
      totalChars += m.content.length + (m.reasoning?.length || 0)
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          totalChars += (tc.output?.length || 0) + JSON.stringify(tc.args).length
        }
      }
    }
    // Heuristic: ~3.5 chars per token for mixed EN/ZH code/prose
    return Math.ceil(totalChars / 3.5)
  }

  public compactIfNeeded(
    sessionId: string,
    messages: Message[],
    systemPrompt = ''
  ): CompressionResult {
    const currentTokens = this.estimateTokens(messages, systemPrompt)

    // Trigger compaction at 70% of maxTokens or when messages count > preserveRecentCount * 2
    if (currentTokens < this.maxTokens * 0.7 && messages.length <= this.preserveRecentCount * 2) {
      return {
        isCompressed: false,
        compressedMessages: messages,
        flushedFactsCount: 0,
        estimatedTokens: currentTokens,
      }
    }

    // 1. Pre-compaction flush to disk
    this.memoryFacade.handlePreCompaction(sessionId, messages, currentTokens, this.maxTokens)

    if (messages.length <= this.preserveRecentCount) {
      return {
        isCompressed: false,
        compressedMessages: messages,
        flushedFactsCount: 0,
        estimatedTokens: currentTokens,
      }
    }

    // 2. Split into older history and recent window
    const older = messages.slice(0, messages.length - this.preserveRecentCount)
    const recent = messages.slice(messages.length - this.preserveRecentCount)

    // 3. Summarize older turns into a single synthetic checkpoint message
    const summaryLines: string[] = []
    older.forEach((m) => {
      if (m.role === 'user') {
        summaryLines.push(`• 用户提出: "${m.content.slice(0, 100)}"`)
      } else if (m.role === 'assistant') {
        summaryLines.push(`• Agent 执行并回答: "${m.content.slice(0, 120)}"`)
      }
    })

    const summaryMessage: Message = {
      id: `summary-checkpoint-${Date.now()}`,
      role: 'system',
      content: `【历史会话压缩摘要 Checkpoint】:\n${summaryLines.join('\n')}\n(关键工程事实与偏好已沉淀至本地长期记忆库)`,
      timestamp: Date.now(),
    }

    const compressedMessages = [summaryMessage, ...recent]
    const newTokens = this.estimateTokens(compressedMessages, systemPrompt)

    return {
      isCompressed: true,
      compressedMessages,
      flushedFactsCount: older.length,
      estimatedTokens: newTokens,
    }
  }
}
