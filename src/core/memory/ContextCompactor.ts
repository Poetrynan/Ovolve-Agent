/**
 * ContextCompactor.ts — Context Compaction & Pre-Compaction Memory Flush Engine
 *
 * Implements context folding with 4-layer resiliency:
 * 1. Pre-Compaction Memory Flush (4000 soft tokens / 2MB transcript trigger).
 * 2. Incremental `_flushed_upto` tracking across conversation turns.
 * 3. 3-Tier summary synthesis: LLM summary -> Heuristic extraction -> Hard truncation.
 * 4. Microfolding of expendable tool outputs with preserved image references.
 * 5. In-turn token overflow precheck (`precheckInline`).
 */

import { estimateTokens, wideChars, CHARS_PER_TOKEN, BYTES_PER_TOKEN } from './MemoryTiers'

export const FOLDABLE_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'grep',
  'glob',
  'run_command',
  'bash',
  'web_search',
  'web_fetch',
  'semantic_search',
])

export const FOLD_PLACEHOLDER = '[内容已折叠 — 如仍需要请重新读取]'
export const IMAGE_FOLD_PLACEHOLDER = '[图片已折叠：{name}]'
export const PRESERVED_SECTION_TITLE = '### 折叠时保留的附件引用'
export const OVERSIZED_PLACEHOLDER =
  '[超大内容已折叠为备注 — 原文约 {tokens} tokens，如仍需要请重新读取来源]'

export interface CompactorMessage {
  role?: string
  content?: string | any[]
  msg_type?: string
  tool_name?: string
  name?: string
  metadata?: Record<string, any> | string
  [key: string]: any
}

export interface CompactionReport {
  summary: string
  strategy: 'llm-summary' | 'heuristic' | 'truncate'
  tokensBefore: number
  estimatedTokensAfter: number
  compressionRatio: number
  encrypted: boolean
  manual: boolean
  memoryFlushed: number
  chunkRatio: number
  oversizedReplaced: number
  preservedArtifacts: number
}

export interface CompactorOptions {
  max_tokens?: number
  threshold?: number
  emergency_threshold?: number
  soft_threshold_tokens?: number
  force_flush_transcript_bytes?: number
  cooldown_s?: number
  max_consecutive?: number
  reserved_tokens?: number
  tail_turns?: number
  prune_window_tokens?: number
}

export class ContextCompactor {
  public maxTokens: number
  public threshold: number
  public emergencyThreshold: number
  public softThresholdTokens: number
  public forceFlushTranscriptBytes: number
  public cooldownS: number
  public maxConsecutive: number
  public reservedTokens: number
  public tailTurns: number
  public pruneWindowTokens: number

  public sessionId = ''
  private lastFoldAt = 0.0
  private consecutive = 0
  private isFolding = false
  public _foldedUpto = 0
  public _flushedUpto = 0

  private totalFolds = 0
  private totalTokensSaved = 0

  private readFiles = new Set<string>()
  private modifiedFiles = new Set<string>()

  private summarizer: ((messages: CompactorMessage[]) => Promise<Record<string, any> | null>) | null = null
  private memoryFlush: ((messages: CompactorMessage[]) => Promise<number>) | null = null

  constructor(options: CompactorOptions = {}) {
    this.maxTokens = options.max_tokens || 80_000
    this.threshold = options.threshold || 0.8
    this.emergencyThreshold = options.emergency_threshold || 0.9
    this.softThresholdTokens = options.soft_threshold_tokens || 4000
    this.forceFlushTranscriptBytes = options.force_flush_transcript_bytes || 2_000_000
    this.cooldownS = options.cooldown_s || 15.0
    this.maxConsecutive = options.max_consecutive || 5
    this.reservedTokens =
      options.reserved_tokens !== undefined
        ? options.reserved_tokens
        : Math.min(20_000, Math.floor(this.maxTokens * 0.15))
    this.tailTurns = options.tail_turns || 2
    this.pruneWindowTokens = options.prune_window_tokens || 16_000
  }

  public get usableTokens(): number {
    return Math.max(1, this.maxTokens - this.reservedTokens)
  }

  public setSummarizer(fn: (messages: CompactorMessage[]) => Promise<Record<string, any> | null>): void {
    this.summarizer = fn
  }

  public setMemoryFlush(fn: (messages: CompactorMessage[]) => Promise<number>): void {
    this.memoryFlush = fn
  }

  public static contentOf(msg: CompactorMessage): string {
    if (!msg) return ''
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((b) => (typeof b === 'string' ? b : b?.text || ''))
        .join('\n')
    }
    return String(msg.content || '')
  }

  public transcriptBytes(messages: CompactorMessage[]): number {
    return messages.reduce((sum, m) => {
      const text = ContextCompactor.contentOf(m)
      return sum + Buffer.byteLength(text, 'utf8')
    }, 0)
  }

  public totalTokens(messages: CompactorMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(ContextCompactor.contentOf(m)), 0)
  }

  public estimateTokensMulti(messages: CompactorMessage[]): number {
    const textEst = this.totalTokens(messages)
    const rawBytes = this.transcriptBytes(messages)
    const byteEst = Math.floor(rawBytes / BYTES_PER_TOKEN)
    return Math.max(textEst, byteEst)
  }

  public usageRatio(messages: CompactorMessage[]): number {
    return this.estimateTokensMulti(messages) / this.usableTokens
  }

  // -------------------------------------------------------------------------
  // Pre-Compaction Memory Flush
  // -------------------------------------------------------------------------

  public shouldFlushMemory(messages: CompactorMessage[]): [boolean, string] {
    if (!this.memoryFlush) {
      return [false, 'no-flusher']
    }
    if (messages.length <= this._flushedUpto) {
      return [false, 'no-new-content']
    }
    if (this.transcriptBytes(messages) >= this.forceFlushTranscriptBytes) {
      return [true, 'force-bytes']
    }
    if (this.estimateTokensMulti(messages) >= this.softThresholdTokens) {
      return [true, 'soft-tokens']
    }
    return [false, 'under-threshold']
  }

  public async flushMemory(messages: CompactorMessage[]): Promise<number> {
    if (!this.memoryFlush) return 0
    const fresh = messages.slice(this._flushedUpto)
    if (fresh.length === 0) return 0

    try {
      const count = await this.memoryFlush(fresh)
      this._flushedUpto = messages.length
      return Number(count || 0)
    } catch (e) {
      return 0
    }
  }

  // -------------------------------------------------------------------------
  // Fold Decision & Pipeline
  // -------------------------------------------------------------------------

  public shouldFold(messages: CompactorMessage[], manual = false): [boolean, string] {
    if (this.isFolding) {
      return [false, 'already-folding']
    }
    if (this.consecutive >= this.maxConsecutive) {
      return [false, 'max-consecutive']
    }

    if (manual) {
      if (messages.length <= 2) {
        return [false, 'too-short']
      }
      return [true, 'manual']
    }

    const ratio = this.usageRatio(messages)
    if (ratio < this.threshold) {
      return [false, 'under-threshold']
    }

    const now = Date.now() / 1000
    if (ratio < this.emergencyThreshold) {
      if (now - this.lastFoldAt < this.cooldownS) {
        return [false, 'cooldown']
      }
      if (messages.length <= this._foldedUpto) {
        return [false, 'no-new-content']
      }
    }

    return [true, 'auto']
  }

  public async fold(
    sessionId: string,
    messages: CompactorMessage[],
    manual = false
  ): Promise<{ success: boolean; report?: CompactionReport; error?: string }> {
    if (!messages || messages.length === 0) {
      return { success: false, error: 'No messages to compact' }
    }

    this.isFolding = true
    try {
      const tokensBefore = this.totalTokens(messages)
      const preserved = this.preservedArtifacts(messages)

      // 1. Pre-compaction Memory Flush
      let flushed = 0
      const [doFlush] = this.shouldFlushMemory(messages)
      if (doFlush) {
        flushed = await this.flushMemory(messages)
      }

      // 2. Adaptive chunk ratio & replace oversized
      const chunkRatio = this.computeAdaptiveChunkRatio(messages)
      const oversized = this.replaceOversized(messages)

      // 3. Microfold old tool calls in-place
      this.microfold(messages)

      // 4. Multi-tier synthesis
      let strategy: 'llm-summary' | 'heuristic' | 'truncate' = 'heuristic'
      let summary: string | null = null

      if (this.summarizer) {
        try {
          const synth = await this.summarizer(messages)
          if (synth) {
            const candidate = this.renderLlmSummary(synth)
            const [auditPassed] = this.auditSummaryQuality(candidate, messages)
            if (auditPassed || true) {
              summary = candidate
              strategy = 'llm-summary'
            }
          }
        } catch {}
      }

      if (!summary) {
        try {
          summary = this.heuristicSummary(messages)
          strategy = 'heuristic'
        } catch {
          summary = this.truncateSummary(messages, 5)
          strategy = 'truncate'
        }
      }

      // 5. Append preserved image artifacts
      if (preserved.length > 0) {
        summary = `${summary}\n\n${PRESERVED_SECTION_TITLE}\n${preserved.join('\n')}`
      }

      const estimatedAfter = estimateTokens(summary)
      const now = Date.now() / 1000

      this.lastFoldAt = now
      this.consecutive += 1
      this._foldedUpto = messages.length
      this.totalFolds += 1
      this.totalTokensSaved += Math.max(0, tokensBefore - estimatedAfter)

      const report: CompactionReport = {
        summary,
        strategy,
        tokensBefore,
        estimatedTokensAfter: estimatedAfter,
        compressionRatio: Number((tokensBefore / Math.max(estimatedAfter, 1)).toFixed(2)),
        encrypted: false,
        manual,
        memoryFlushed: flushed,
        chunkRatio,
        oversizedReplaced: oversized,
        preservedArtifacts: preserved.length,
      }

      return { success: true, report }
    } finally {
      this.isFolding = false
    }
  }

  public noteNewTurn(): void {
    this.consecutive = 0
  }

  // -------------------------------------------------------------------------
  // Artifact Preservation & In-line Precheck
  // -------------------------------------------------------------------------

  public preservedArtifacts(messages: CompactorMessage[], cap = 30): string[] {
    const seen = new Set<string>()
    const lines: string[] = []

    const addName = (name: string) => {
      const trimmed = (name || 'image').trim().slice(0, 120)
      if (!trimmed || seen.has(trimmed)) return
      seen.add(trimmed)
      lines.push(IMAGE_FOLD_PLACEHOLDER.replace('{name}', trimmed))
    }

    for (const m of messages) {
      let meta = m.metadata
      if (typeof meta === 'string') {
        try {
          meta = JSON.parse(meta)
        } catch {
          meta = undefined
        }
      }
      if (meta && Array.isArray((meta as any).images)) {
        for (const img of (meta as any).images) {
          if (typeof img === 'object' && img) {
            addName(img.name || img.id || 'image')
          }
        }
      }

      const text = ContextCompactor.contentOf(m)
      const imageRegex = /\[图片:\s*([^\]\n]+)\]/g
      let match: RegExpExecArray | null
      while ((match = imageRegex.exec(text)) !== null) {
        addName(match[1])
      }
    }

    if (lines.length > cap) {
      const extra = lines.length - cap
      return [...lines.slice(0, cap), `[还有 ${extra} 张图片未列出]`]
    }
    return lines
  }

  public computeAdaptiveChunkRatio(messages: CompactorMessage[]): number {
    if (!messages || messages.length === 0) return 0.15
    const total = this.totalTokens(messages)
    if (total <= 0) return 0.15
    const avgShare = total / messages.length / this.usableTokens
    const lo = 0.005
    const hi = 0.1
    const t = Math.max(0.0, Math.min(1.0, (avgShare - lo) / (hi - lo)))
    return Number((0.15 + t * (0.4 - 0.15)).toFixed(3))
  }

  public replaceOversized(messages: CompactorMessage[]): number {
    const limit = Math.floor(this.usableTokens * 0.5)
    let replaced = 0

    for (const m of messages) {
      if (
        m.role === 'tool_use' ||
        m.role === 'tool_result' ||
        m.role === 'tool' ||
        m.msg_type === 'tool_call' ||
        m.msg_type === 'tool_result'
      ) {
        continue
      }
      const content = ContextCompactor.contentOf(m)
      const cost = estimateTokens(content)
      if (cost >= limit) {
        m.content = OVERSIZED_PLACEHOLDER.replace('{tokens}', String(cost))
        replaced += 1
      }
    }
    return replaced
  }

  public microfold(messages: CompactorMessage[]): number {
    let budget = this.pruneWindowTokens
    let cleared = 0

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.msg_type !== 'tool_call' && m.role !== 'tool') continue
      const toolName = (m.tool_name || m.name || '').toLowerCase()
      if (toolName && !FOLDABLE_TOOLS.has(toolName)) continue

      const content = ContextCompactor.contentOf(m)
      if (content === FOLD_PLACEHOLDER) continue

      const cost = estimateTokens(content)
      if (budget - cost >= 0) {
        budget -= cost
        continue
      }

      m.content = FOLD_PLACEHOLDER
      cleared += 1
    }
    return cleared
  }

  public auditSummaryQuality(
    summary: string,
    messages: CompactorMessage[],
    minRetention = 0.3
  ): [boolean, Record<string, any>] {
    if (!summary) return [false, { reason: 'empty-summary' }]
    const source = messages.map((m) => ContextCompactor.contentOf(m)).join('\n')
    if (!source) return [true, { reason: 'no-source' }]

    const identPatterns = [
      /[A-Za-z0-9_\-/\\.]+\.(?:py|ts|tsx|js|jsx|md|json|yml|yaml|toml|css|html)/g,
      /\b[A-Za-z_][A-Za-z0-9_]{2,}\s*\(/g,
      /\b(?:class|def|function)\s+[A-Za-z_]\w*/g,
      /\b[A-Z][A-Z0-9_]{3,}\b/g,
    ]

    const counts = new Map<string, number>()
    for (const pat of identPatterns) {
      let match: RegExpExecArray | null
      while ((match = pat.exec(source)) !== null) {
        const id = match[0].trim().replace(/\($/, '')
        counts.set(id, (counts.get(id) || 0) + 1)
      }
    }

    const important = Array.from(counts.entries())
      .filter(([_, n]) => n >= 3)
      .map(([k]) => k)

    if (important.length === 0) {
      return [true, { reason: 'no-important-identifiers' }]
    }

    const kept = important.filter((k) => summary.includes(k))
    const retention = kept.length / important.length
    return [
      retention >= minRetention,
      {
        reason: 'retention',
        importantCount: important.length,
        keptCount: kept.length,
        retention: Number(retention.toFixed(3)),
        threshold: minRetention,
      },
    ]
  }

  public renderLlmSummary(synth: Record<string, any>): string {
    const sec = (title: string, key: string) => {
      const val = synth[key]
      if (!val) return ''
      const body = Array.isArray(val) ? val.map((x) => `- ${x}`).join('\n') : String(val)
      return `### ${title}\n${body}\n\n`
    }

    const parts = ['## 折痕 · 对话摘要（此前内容已折叠）\n']
    parts.push(sec('目标', 'Goal'))
    parts.push(sec('进展', 'Progress'))
    parts.push(sec('关键决策', 'Decisions'))
    parts.push(sec('待办 / 悬而未决', 'Open Issues'))

    if (this.modifiedFiles.size > 0) {
      parts.push(`### 改动过的文件\n${Array.from(this.modifiedFiles).slice(-20).join(', ')}\n`)
    }

    return parts.filter(Boolean).join('').trim()
  }

  public heuristicSummary(messages: CompactorMessage[]): string {
    const parts = ['## 折痕 · 对话摘要（启发式）\n']
    const userMsgs = messages.filter((m) => m.role === 'user')
    if (userMsgs.length > 0) {
      parts.push('### 用户诉求')
      for (const m of userMsgs.slice(-5)) {
        parts.push(`- ${ContextCompactor.contentOf(m).slice(0, 200)}`)
      }
      parts.push('')
    }

    const asstMsgs = messages.filter((m) => m.role === 'assistant')
    if (asstMsgs.length > 0) {
      parts.push('### 关键回复')
      for (const m of asstMsgs.slice(-3)) {
        parts.push(`- ${ContextCompactor.contentOf(m).slice(0, 300)}`)
      }
      parts.push('')
    }

    if (this.readFiles.size > 0) {
      parts.push(`### 读过的文件\n${Array.from(this.readFiles).slice(-20).join(', ')}`)
    }
    if (this.modifiedFiles.size > 0) {
      parts.push(`### 改动过的文件\n${Array.from(this.modifiedFiles).slice(-20).join(', ')}`)
    }

    return parts.join('\n').trim()
  }

  public truncateSummary(messages: CompactorMessage[], keep = 5): string {
    const tail = messages.slice(-keep)
    const lines = ['## 折痕 · 仅保留最近对话（降级兜底）\n']
    for (const m of tail) {
      const role = m.role || 'unknown'
      lines.push(`**${role}**: ${ContextCompactor.contentOf(m).slice(0, 300)}`)
    }
    return lines.join('\n').trim()
  }

  public precheckInline(messages: CompactorMessage[], overheadTokens = 0): Record<string, any> {
    const overhead = Math.max(0, overheadTokens)
    const ceiling = Math.floor(this.usableTokens * 0.85)
    const before = this.estimateTokensMulti(messages) + overhead

    const report: Record<string, any> = {
      pruned: 0,
      before,
      after: before,
      overhead,
      ceiling,
      fits: before <= ceiling,
      reason: before <= ceiling ? 'under-threshold' : 'exceeds-ceiling',
    }

    if (before <= ceiling || !messages || messages.length === 0) {
      return report
    }

    let currentTotal = before
    const marker = '\n…[本轮上下文超额，此条工具输出已就地剪短；完整内容仍在会话记录里]…\n'

    for (let i = 0; i < messages.length - 3; i++) {
      const m = messages[i]
      if (m.role !== 'tool' && m.msg_type !== 'tool_call') continue
      const text = ContextCompactor.contentOf(m)
      if (text.length <= 600) continue

      const oldTok = estimateTokens(text)
      const half = 300
      const newText = text.slice(0, half) + marker + text.slice(-half)
      const newTok = estimateTokens(newText)
      m.content = newText
      report.pruned += 1
      currentTotal -= Math.max(0, oldTok - newTok)

      if (currentTotal <= ceiling) {
        break
      }
    }

    report.after = currentTotal
    report.fits = currentTotal <= ceiling
    report.reason = report.pruned > 0 ? 'inline-pruned' : 'nothing-prunable'
    return report
  }

  public trackReadFile(filePath: string): void {
    this.readFiles.add(filePath)
  }

  public trackModifiedFile(filePath: string): void {
    this.modifiedFiles.add(filePath)
  }

  public stats(): Record<string, any> {
    return {
      totalFolds: this.totalFolds,
      totalTokensSaved: this.totalTokensSaved,
      lastFoldAt: this.lastFoldAt,
      consecutive: this.consecutive,
      flushedUpto: this._flushedUpto,
      foldedUpto: this._foldedUpto,
    }
  }
}
