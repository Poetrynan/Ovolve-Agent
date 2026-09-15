/**
 * DispatchPipeline.ts — 4-Stage Subagent Dispatch Pipeline
 *
 * Implements the 4-stage pipeline:
 * 1. Admission Control (`admit`): Concurrency limit (<= 8), recursion depth (<= 2), token budget (> 0).
 * 2. Steer & Dynamic Tool Trimming (`steer`): Intent keyword analysis, RoleSpec resolution, tool allowlists.
 * 3. Dispatch & Session Isolation (`dispatch`): Isolated child session IDs (`subagent-${uuid8}`), history snapshotting.
 * 4. Delivery Verification (`deliver`): ResultContract schema typing & required fields check.
 */

import crypto from 'node:crypto'
import { roleSpec, checkResultContract, RoleSpec, ResultSchema } from './RolePresets'

export interface SteerResult {
  role: string
  persona: string
  spec: RoleSpec
  activeTools: string[]
}

export interface DispatchResult {
  taskId: string
  childSessionId: string
  parentSessionId: string
  role: string
  persona: string
  dispatchedAt: number
  forked: boolean
}

export interface DeliveryResult {
  ok: boolean
  problems: string[]
}

export class DispatchPipeline {
  public maxConcurrent: number
  public maxDepth: number

  constructor(maxConcurrent: number = 8, maxDepth: number = 2) {
    this.maxConcurrent = maxConcurrent
    this.maxDepth = maxDepth
  }

  /**
   * Stage 1: Admission Control.
   * Enforces concurrency ceiling, subagent recursion depth, and token budget positivity.
   */
  public admit(
    currentConcurrent: number,
    depth: number,
    tokenBudget: number = 50000,
  ): { ok: boolean; reason: string } {
    if (currentConcurrent >= this.maxConcurrent) {
      return {
        ok: false,
        reason: `concurrency limit reached (${currentConcurrent}/${this.maxConcurrent})`,
      }
    }

    if (depth > this.maxDepth) {
      return {
        ok: false,
        reason: `maximum subagent recursion depth exceeded (${depth} > ${this.maxDepth})`,
      }
    }

    if (tokenBudget <= 0) {
      return {
        ok: false,
        reason: 'insufficient token budget allocated',
      }
    }

    return { ok: true, reason: '' }
  }

  /**
   * Stage 2: Steer & Dynamic Specialization.
   * Analyzes prompt intent keywords and narrows persona tool allowlist to canonical subset.
   */
  public steer(
    taskPrompt: string,
    requestedPersona: string = '',
    requestedRole: string = '',
    personaTools?: string[],
  ): SteerResult {
    let role = requestedRole

    if (!role) {
      const promptLower = (taskPrompt || '').toLowerCase()
      if (['review', 'diff', 'audit', 'check', '审查', '代码评审'].some((k) => promptLower.includes(k))) {
        role = 'reviewer'
      } else if (['search', 'find', 'explore', 'research', 'investigate', '调研', '搜索'].some((k) => promptLower.includes(k))) {
        role = 'researcher'
      } else if (['plan', 'decompose', 'design', '规划', '拆解'].some((k) => promptLower.includes(k))) {
        role = 'planner'
      } else if (['diagnose', 'error', 'trace', 'bug', '排查', '诊断'].some((k) => promptLower.includes(k))) {
        role = 'diagnostician'
      } else {
        role = 'coder'
      }
    }

    const spec = roleSpec(role)
    const persona = requestedPersona || role

    // Tool allowlist intersection: Persona Tools ∩ RoleSpec Tools
    let activeTools: string[] = [...spec.tools]
    if (personaTools && Array.isArray(personaTools)) {
      const roleToolSet = new Set(spec.tools)
      activeTools = personaTools.filter((t) => roleToolSet.has(t))
    }

    return {
      role,
      persona,
      spec,
      activeTools,
    }
  }

  /**
   * Stage 3: Dispatch & Session Isolation.
   * Prepares isolated subagent session with unique childSessionId and scheduling timestamp.
   */
  public dispatch(
    taskId: string,
    roleInfo: SteerResult,
    parentSessionId: string,
    options?: { forked?: boolean },
  ): DispatchResult {
    const rawUuid = crypto.randomUUID().replace(/-/g, '')
    const childSessionId = `subagent-${rawUuid.slice(0, 8)}`

    return {
      taskId,
      childSessionId,
      parentSessionId,
      role: roleInfo.role,
      persona: roleInfo.persona,
      dispatchedAt: Date.now(),
      forked: Boolean(options?.forked),
    }
  }

  /**
   * Stage 4: Delivery Contract Verification.
   * Evaluates delivered subagent payload against expected ResultContract schema.
   */
  public deliver(resultPayload: any, expectedSchema: ResultSchema): DeliveryResult {
    return checkResultContract(resultPayload, expectedSchema)
  }
}

export const defaultDispatchPipeline = new DispatchPipeline(8, 2)
