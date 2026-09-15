import fs from 'node:fs'
import path from 'node:path'

export interface EvolutionRule {
  id: string
  triggerSignature: string
  ruleContent: string
  category: 'safety' | 'tool_usage' | 'preference'
  createdAt: number
  successCount: number
  failureCount: number
}

export class GepaEvolutionEngine {
  private static instance: GepaEvolutionEngine
  private rulesPath: string
  private rules: EvolutionRule[] = []

  constructor(rulesPath = '.ovolve/evolved_rules.json') {
    this.rulesPath = rulesPath
    this.loadRules()
  }

  public static getInstance(): GepaEvolutionEngine {
    if (!GepaEvolutionEngine.instance) {
      GepaEvolutionEngine.instance = new GepaEvolutionEngine()
    }
    return GepaEvolutionEngine.instance
  }

  private loadRules(): void {
    try {
      if (fs.existsSync(this.rulesPath)) {
        const raw = fs.readFileSync(this.rulesPath, 'utf8')
        this.rules = JSON.parse(raw)
      }
    } catch {
      this.rules = []
    }
  }

  private saveRules(): void {
    try {
      const dir = path.dirname(this.rulesPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(this.rulesPath, JSON.stringify(this.rules, null, 2), 'utf8')
    } catch {}
  }

  /**
   * Capture user correction and evolve a new defensive rule
   */
  public recordUserCorrection(userFeedback: string, previousTool?: string): EvolutionRule {
    const cleanFeedback = userFeedback.trim()
    const trigger = previousTool ? `tool_error:${previousTool}` : 'user_correction'
    const ruleContent = `【自进化守则】: 用户曾明确指出 "${cleanFeedback}"。在类似场景下务必优先遵守此指示。`

    const rule: EvolutionRule = {
      id: `rule-${Date.now()}`,
      triggerSignature: trigger,
      ruleContent,
      category: 'safety',
      createdAt: Date.now(),
      successCount: 1,
      failureCount: 0,
    }

    this.rules.push(rule)
    this.saveRules()
    return rule
  }

  /**
   * Record failure signature from RepeatToolGuard or execution failure
   */
  public recordFailureSignature(signature: string, advisory: string): EvolutionRule {
    const rule: EvolutionRule = {
      id: `rule-fail-${Date.now()}`,
      triggerSignature: signature,
      ruleContent: `【防故障守则 (${signature})】: ${advisory}`,
      category: 'safety',
      createdAt: Date.now(),
      successCount: 1,
      failureCount: 0,
    }

    this.rules.push(rule)
    this.saveRules()
    return rule
  }

  /**
   * Format all active evolved rules for system prompt injection
   */
  public getEvolvedRulesPrompt(): string {
    if (this.rules.length === 0) return ''

    const lines = this.rules.map((r, i) => `${i + 1}. ${r.ruleContent}`)
    return `\n\n【OvolveAgent 闭环自进化行为守则】:\n${lines.join('\n')}`
  }

  public getRules(): EvolutionRule[] {
    return [...this.rules]
  }

  public clear(): void {
    this.rules = []
    this.saveRules()
  }
}
