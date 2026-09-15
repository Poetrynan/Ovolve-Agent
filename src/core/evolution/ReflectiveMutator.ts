/**
 * ReflectiveMutator.ts — Reflection-Guided Mutation, Failure Taxonomy Diagnosis & Genetic Operators
 *
 * Implements:
 * 1. Execution trace failure taxonomy diagnosis (permission_denied, timeout_exhaustion, etc.).
 * 2. Reflection-guided prompt mutation injecting `【GEPA 自进化安全守则】`.
 * 3. Genetic crossover & simplification operators.
 * 4. Multi-generation evolutionary optimization cycles.
 */

import crypto from 'node:crypto'
import { GenomeCandidate, FitnessVector, computeParetoFront, GEPAEvolutionOptimizer, EvalCase } from './GepaEvolution'

export interface FailureDiagnosis {
  root_cause: string
  suggested_guardrail: string
  suggested_step_patch: string
  severity: 'low' | 'medium' | 'high'
}

export class ReflectiveMutator {
  /**
   * Diagnoses root causes from execution failure traces and proposes concrete rule patches.
   */
  public static diagnoseFailureTrace(trace: {
    error?: string
    output?: string
    tool?: string
    name?: string
    args?: any
  }): FailureDiagnosis {
    const error = String(trace.error || trace.output || '')
    const toolName = String(trace.tool || trace.name || 'unknown_tool')
    const args = trace.args || {}
    const errLower = error.toLowerCase()

    if (
      errLower.includes('permission') ||
      errLower.includes('access denied') ||
      errLower.includes('readonly') ||
      errLower.includes('eacces') ||
      errLower.includes('eperm')
    ) {
      return {
        root_cause: 'permission_denied',
        suggested_guardrail: `严禁对受保护/只读路径执行写操作 (涉及工具: ${toolName})`,
        suggested_step_patch: '',
        severity: 'high',
      }
    }

    if (
      errLower.includes('timeout') ||
      errLower.includes('timed out') ||
      errLower.includes('etimedout')
    ) {
      return {
        root_cause: 'timeout_exhaustion',
        suggested_guardrail: '',
        suggested_step_patch: `拆分大批量任务，为 ${toolName} 设置合理超时时间与分页读取`,
        severity: 'medium',
      }
    }

    if (
      errLower.includes('not found') ||
      errLower.includes('enoent') ||
      errLower.includes('cannot find') ||
      errLower.includes('missing file')
    ) {
      return {
        root_cause: 'file_or_resource_not_found',
        suggested_guardrail: `调用 ${toolName} 前必须先执行 find_files / list_dir 验证路径存在`,
        suggested_step_patch: '',
        severity: 'low',
      }
    }

    if (
      errLower.includes('schema') ||
      errLower.includes('contract rejected') ||
      errLower.includes('missing key') ||
      errLower.includes('validation error')
    ) {
      return {
        root_cause: 'contract_schema_mismatch',
        suggested_guardrail: '',
        suggested_step_patch: '严格按照 ResultContract Schema 输出必需的结构化键值',
        severity: 'high',
      }
    }

    return {
      root_cause: 'generic_tool_error',
      suggested_guardrail: `调用 ${toolName} 时严格校验入参类型: ${JSON.stringify(args).slice(0, 100)}`,
      suggested_step_patch: '',
      severity: 'medium',
    }
  }

  /**
   * Applies reflection-guided mutation to generate a patched genome candidate.
   */
  public mutatePrompt(
    parent: GenomeCandidate,
    failureTraces: Array<{ error?: string; output?: string; tool?: string; args?: any }>,
    generation: number,
  ): GenomeCandidate {
    const cid = `gepa_${crypto.randomUUID().slice(0, 8)}`
    const newGuardrails = [...parent.guardrails]
    const newSteps = [...parent.steps]
    const reflectionNotesList: string[] = []

    const tracesToInspect = (failureTraces || []).slice(0, 3)
    for (const tr of tracesToInspect) {
      const diag = ReflectiveMutator.diagnoseFailureTrace(tr)
      if (diag.suggested_guardrail && !newGuardrails.includes(diag.suggested_guardrail)) {
        newGuardrails.push(diag.suggested_guardrail)
        reflectionNotesList.push(`新增防线: ${diag.suggested_guardrail}`)
      }
      if (diag.suggested_step_patch && !newSteps.includes(diag.suggested_step_patch)) {
        newSteps.push(diag.suggested_step_patch)
        reflectionNotesList.push(`增加步骤: ${diag.suggested_step_patch}`)
      }
    }

    let enhancedPrompt = parent.promptContent.trim()
    if (newGuardrails.length > 0) {
      const guardrailSection =
        '\n\n【GEPA 自进化安全守则】:\n' +
        newGuardrails
          .slice(-4)
          .map((g) => `- ${g}`)
          .join('\n')

      if (!enhancedPrompt.includes('【GEPA 自进化安全守则】')) {
        enhancedPrompt += guardrailSection
      } else {
        const parts = enhancedPrompt.split('【GEPA 自进化安全守则】')
        enhancedPrompt = parts[0].trim() + guardrailSection
      }
    }

    return new GenomeCandidate({
      candidateId: cid,
      generation,
      name: `${parent.name}_gen${generation}`,
      promptContent: enhancedPrompt,
      preconditions: parent.preconditions,
      steps: newSteps,
      guardrails: newGuardrails,
      mutationType: 'reflection_patch',
      parentIds: [parent.candidateId],
      reflectionNotes: reflectionNotesList.join('; ') || 'Reflective evolution applied',
    })
  }

  /**
   * Merges guardrails and procedures from two parent genomes via genetic crossover.
   */
  public crossover(
    parentA: GenomeCandidate,
    parentB: GenomeCandidate,
    generation: number,
  ): GenomeCandidate {
    const cid = `gepa_cross_${crypto.randomUUID().slice(0, 8)}`
    const mergedGuardrails = Array.from(new Set([...parentA.guardrails, ...parentB.guardrails]))
    const mergedSteps = Array.from(new Set([...parentA.steps, ...parentB.steps]))

    const descA = parentA.promptContent.split('【GEPA 自进化安全守则】')[0].trim()
    const descB = parentB.promptContent.split('【GEPA 自进化安全守则】')[0].trim()
    let combinedDesc = descA.length <= descB.length ? descA : descB

    if (mergedGuardrails.length > 0) {
      combinedDesc +=
        '\n\n【GEPA 自进化安全守则】:\n' +
        mergedGuardrails
          .slice(0, 6)
          .map((g) => `- ${g}`)
          .join('\n')
    }

    return new GenomeCandidate({
      candidateId: cid,
      generation,
      name: `${parentA.name}_x_${parentB.name}`,
      promptContent: combinedDesc,
      preconditions: parentA.preconditions || parentB.preconditions,
      steps: mergedSteps,
      guardrails: mergedGuardrails,
      mutationType: 'crossover',
      parentIds: [parentA.candidateId, parentB.candidateId],
      reflectionNotes: `Crossover between ${parentA.candidateId} and ${parentB.candidateId}`,
    })
  }

  /**
   * Prunes redundant whitespace, steps, and guardrails to maximize token efficiency.
   */
  public simplify(parent: GenomeCandidate, generation: number): GenomeCandidate {
    const cid = `gepa_simp_${crypto.randomUUID().slice(0, 8)}`
    let compactPrompt = parent.promptContent.replace(/\n{3,}/g, '\n\n')
    compactPrompt = compactPrompt.replace(/[ \t]+/g, ' ').trim()

    return new GenomeCandidate({
      candidateId: cid,
      generation,
      name: `${parent.name}_compact`,
      promptContent: compactPrompt,
      preconditions: parent.preconditions,
      steps: parent.steps.slice(0, 8),
      guardrails: parent.guardrails.slice(0, 6),
      mutationType: 'simplify',
      parentIds: [parent.candidateId],
      reflectionNotes: 'Pruned redundancy to maximize token efficiency',
    })
  }

  /**
   * Executes a full multi-generation GEPA evolution cycle.
   */
  public runEvolutionCycle(
    seedPrompt: string,
    seedName: string,
    evalCases: EvalCase[] = [],
    failureTraces: Array<{ error?: string; output?: string; tool?: string; args?: any }> = [],
    maxGenerations: number = 3,
    populationSize: number = 6,
  ): {
    winner: Record<string, any>
    paretoFront: Record<string, any>[]
    generationsLog: Array<Record<string, any>>
    seedFitness: Record<string, any>
    winnerFitness: Record<string, any>
    improved: boolean
  } {
    const optimizer = new GEPAEvolutionOptimizer()

    const seed = new GenomeCandidate({
      candidateId: 'gepa_seed_0',
      generation: 0,
      name: seedName,
      promptContent: seedPrompt,
      mutationType: 'seed',
    })
    optimizer.evaluateCandidate(seed, evalCases)

    let population: GenomeCandidate[] = [seed]
    const generationsLog: Array<Record<string, any>> = []

    for (let gen = 1; gen <= maxGenerations; gen++) {
      const nextPop: GenomeCandidate[] = [...population]
      const currentFront = computeParetoFront(population)

      // (a) Reflective Mutation on top candidates
      for (const elite of currentFront.slice(0, 3)) {
        const mutant = this.mutatePrompt(elite, failureTraces, gen)
        optimizer.evaluateCandidate(mutant, evalCases)
        nextPop.push(mutant)
      }

      // (b) Crossover between top candidates
      if (currentFront.length >= 2) {
        const child = this.crossover(currentFront[0], currentFront[1], gen)
        optimizer.evaluateCandidate(child, evalCases)
        nextPop.push(child)
      }

      // (c) Simplification
      if (currentFront.length > 0) {
        const simplified = this.simplify(currentFront[0], gen)
        optimizer.evaluateCandidate(simplified, evalCases)
        nextPop.push(simplified)
      }

      // (d) Pareto-front selection & population capacity control
      const nextFront = computeParetoFront(nextPop)
      population = nextFront.slice(0, populationSize)

      generationsLog.push({
        generation: gen,
        populationSize: population.length,
        paretoFrontSize: nextFront.length,
        bestScalarScore: population.length > 0 ? population[0].fitness.scalarScore() : 0.0,
      })
    }

    const finalPareto = computeParetoFront(population)
    const winner = finalPareto.length > 0 ? finalPareto[0] : seed

    return {
      winner: winner.toDict(),
      paretoFront: finalPareto.map((c) => c.toDict()),
      generationsLog,
      seedFitness: seed.fitness.toDict(),
      winnerFitness: winner.fitness.toDict(),
      improved: winner.fitness.scalarScore() > seed.fitness.scalarScore(),
    }
  }
}
