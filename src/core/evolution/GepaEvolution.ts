/**
 * GepaEvolution.ts — Gene Expression Programming Agent (GEPA) Multi-Objective Pareto Evolution
 *
 * Implements:
 * 1. Multi-Objective Pareto Fitness Vector: F = (f_success, -f_cost, -f_latency, f_safety).
 * 2. Strict Pareto Dominance checking & scalarized tie-breaking.
 * 3. Non-dominated sorting algorithm (`computeParetoFront`).
 * 4. Natural language genome representation and evolutionary optimization loop.
 */

import crypto from 'node:crypto'

export class FitnessVector {
  public successRate: number
  public tokenEfficiency: number
  public latencyScore: number
  public safetyScore: number
  public evaluatedCases: number
  public rawCostTokens: number
  public rawLatencyMs: number

  constructor(options?: Partial<{
    successRate: number
    tokenEfficiency: number
    latencyScore: number
    safetyScore: number
    evaluatedCases: number
    rawCostTokens: number
    rawLatencyMs: number
  }>) {
    this.successRate = options?.successRate ?? 0.0
    this.tokenEfficiency = options?.tokenEfficiency ?? 0.5
    this.latencyScore = options?.latencyScore ?? 0.5
    this.safetyScore = options?.safetyScore ?? 1.0
    this.evaluatedCases = options?.evaluatedCases ?? 0
    this.rawCostTokens = options?.rawCostTokens ?? 0
    this.rawLatencyMs = options?.rawLatencyMs ?? 0.0
  }

  /**
   * Pareto dominance check:
   * Returns true iff this vector is >= other across all 4 objectives and strictly > on at least one.
   */
  public dominates(other: FitnessVector): boolean {
    const curr = [this.successRate, this.tokenEfficiency, this.latencyScore, this.safetyScore]
    const oth = [other.successRate, other.tokenEfficiency, other.latencyScore, other.safetyScore]

    const allGe = curr.every((c, idx) => c >= oth[idx] - 1e-6)
    const anyGt = curr.some((c, idx) => c > oth[idx] + 1e-6)

    return allGe && anyGt
  }

  /**
   * Weighted scalar score for tie-breaking.
   * Default weights: success = 0.50, efficiency = 0.15, latency = 0.10, safety = 0.25.
   */
  public scalarScore(weights: [number, number, number, number] = [0.5, 0.15, 0.1, 0.25]): number {
    return (
      this.successRate * weights[0] +
      this.tokenEfficiency * weights[1] +
      this.latencyScore * weights[2] +
      this.safetyScore * weights[3]
    )
  }

  public toDict(): Record<string, any> {
    return {
      successRate: Number(this.successRate.toFixed(4)),
      tokenEfficiency: Number(this.tokenEfficiency.toFixed(4)),
      latencyScore: Number(this.latencyScore.toFixed(4)),
      safetyScore: Number(this.safetyScore.toFixed(4)),
      scalarScore: Number(this.scalarScore().toFixed(4)),
      evaluatedCases: this.evaluatedCases,
      rawCostTokens: this.rawCostTokens,
      rawLatencyMs: Number(this.rawLatencyMs.toFixed(2)),
    }
  }
}

export class GenomeCandidate {
  public candidateId: string
  public generation: number
  public name: string
  public promptContent: string
  public preconditions: string
  public steps: string[]
  public guardrails: string[]
  public mutationType: 'seed' | 'reflection_patch' | 'crossover' | 'simplify'
  public parentIds: string[]
  public reflectionNotes: string
  public fitness: FitnessVector
  public createdAt: number

  constructor(options: {
    candidateId: string
    generation: number
    name: string
    promptContent: string
    preconditions?: string
    steps?: string[]
    guardrails?: string[]
    mutationType?: 'seed' | 'reflection_patch' | 'crossover' | 'simplify'
    parentIds?: string[]
    reflectionNotes?: string
    fitness?: FitnessVector
    createdAt?: number
  }) {
    this.candidateId = options.candidateId
    this.generation = options.generation
    this.name = options.name
    this.promptContent = options.promptContent
    this.preconditions = options.preconditions || ''
    this.steps = options.steps ? [...options.steps] : []
    this.guardrails = options.guardrails ? [...options.guardrails] : []
    this.mutationType = options.mutationType || 'seed'
    this.parentIds = options.parentIds ? [...options.parentIds] : []
    this.reflectionNotes = options.reflectionNotes || ''
    this.fitness = options.fitness || new FitnessVector()
    this.createdAt = options.createdAt || Date.now()
  }

  /**
   * Generates a 16-character SHA-256 fingerprint hash of the genome content.
   */
  public genomeHash(): string {
    const normalized = [
      this.promptContent.trim(),
      this.preconditions.trim(),
      this.steps.join(';'),
      this.guardrails.join(';'),
    ].join('\n')

    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
  }

  public toDict(): Record<string, any> {
    return {
      candidateId: this.candidateId,
      generation: this.generation,
      name: this.name,
      promptContent: this.promptContent,
      preconditions: this.preconditions,
      steps: [...this.steps],
      guardrails: [...this.guardrails],
      mutationType: this.mutationType,
      parentIds: [...this.parentIds],
      reflectionNotes: this.reflectionNotes,
      fitness: this.fitness.toDict(),
      genomeHash: this.genomeHash(),
      createdAt: this.createdAt,
    }
  }
}

/**
 * Computes the Pareto Frontier (set of non-dominated candidates) from a population.
 * Deduplicates candidates by genome fingerprint and ranks the frontier by scalar score descending.
 */
export function computeParetoFront(candidates: GenomeCandidate[]): GenomeCandidate[] {
  if (!candidates || candidates.length === 0) {
    return []
  }

  // Deduplicate by genome hash
  const uniqueCandidates: GenomeCandidate[] = []
  const seenHashes = new Set<string>()

  for (const c of candidates) {
    const h = c.genomeHash()
    if (!seenHashes.has(h)) {
      seenHashes.add(h)
      uniqueCandidates.push(c)
    }
  }

  const paretoFront: GenomeCandidate[] = []
  const n = uniqueCandidates.length

  for (let i = 0; i < n; i++) {
    const candidateI = uniqueCandidates[i]
    let isDominated = false

    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const candidateJ = uniqueCandidates[j]
      if (candidateJ.fitness.dominates(candidateI.fitness)) {
        isDominated = true
        break
      }
    }

    if (!isDominated) {
      paretoFront.push(candidateI)
    }
  }

  // Sort Pareto Front by scalar score descending
  paretoFront.sort((a, b) => b.fitness.scalarScore() - a.fitness.scalarScore())
  return paretoFront
}

export interface EvalCase {
  prompt?: string
  expected_guardrail?: string
  expected_error?: boolean
  base_tokens?: number
  base_steps?: number
}

export interface SimulationResult {
  ok: boolean
  safe: boolean
  tokens: number
  steps: number
}

export class GEPAEvolutionOptimizer {
  public evaluateCandidate(
    candidate: GenomeCandidate,
    evalCases: EvalCase[],
    simulatorFn?: (candidate: GenomeCandidate, testCase: EvalCase) => SimulationResult,
  ): FitnessVector {
    if (!evalCases || evalCases.length === 0) {
      candidate.fitness = new FitnessVector({
        successRate: 1.0,
        tokenEfficiency: 0.8,
        latencyScore: 0.8,
        safetyScore: 1.0,
        evaluatedCases: 0,
      })
      return candidate.fitness
    }

    let successCount = 0
    let safetyPassCount = 0
    let totalTokens = 0
    let totalSteps = 0
    const nCases = evalCases.length

    for (const testCase of evalCases) {
      let res: SimulationResult
      if (simulatorFn) {
        res = simulatorFn(candidate, testCase)
      } else {
        const isErrCase = Boolean(testCase.expected_error)
        const expectedGuard = testCase.expected_guardrail || ''

        let passed = true
        if (expectedGuard && !candidate.promptContent.includes(expectedGuard)) {
          passed = false
        }

        const promptWordCount = candidate.promptContent.split(/\s+/).filter(Boolean).length
        const tokens = promptWordCount * 2 + (testCase.base_tokens || 100)
        const steps = candidate.steps.length > 0 ? candidate.steps.length : (testCase.base_steps || 3)

        res = {
          ok: passed,
          safe: !isErrCase || passed,
          tokens,
          steps,
        }
      }

      if (res.ok) successCount++
      if (res.safe) safetyPassCount++
      totalTokens += res.tokens || 200
      totalSteps += res.steps || 3
    }

    const avgTokens = totalTokens / Math.max(1, nCases)
    const tokenEff = Math.max(0.05, Math.min(1.0, 1.0 - avgTokens / 5000.0))
    const avgSteps = totalSteps / Math.max(1, nCases)
    const latencyScore = Math.max(0.05, Math.min(1.0, 1.0 - avgSteps / 20.0))

    candidate.fitness = new FitnessVector({
      successRate: successCount / nCases,
      tokenEfficiency: tokenEff,
      latencyScore,
      safetyScore: safetyPassCount / nCases,
      evaluatedCases: nCases,
      rawCostTokens: Math.round(avgTokens),
      rawLatencyMs: avgSteps * 500.0,
    })

    return candidate.fitness
  }
}
