import crypto from 'node:crypto'

export type AgentRole = 'coder' | 'reviewer' | 'researcher' | 'planner' | 'diagnostician'

export interface RoleSpec {
  role: AgentRole
  description: string
  allowedTools: string[]
}

export const ROLE_SPECS: Record<AgentRole, RoleSpec> = {
  coder: {
    role: 'coder',
    description: 'Autonomous software engineer specialized in code modification and building.',
    allowedTools: ['run_command', 'write_to_file', 'replace_file_content', 'view_file'],
  },
  reviewer: {
    role: 'reviewer',
    description: 'Adversarial code reviewer checking logic correctness and regression safety.',
    allowedTools: ['view_file', 'grep_search', 'run_command'],
  },
  researcher: {
    role: 'researcher',
    description: 'Codebase explorer and fact finder.',
    allowedTools: ['view_file', 'grep_search', 'find_by_name', 'search_web'],
  },
  planner: {
    role: 'planner',
    description: 'Task decomposition and high-level architectural architect.',
    allowedTools: ['view_file', 'grep_search'],
  },
  diagnostician: {
    role: 'diagnostician',
    description: 'Error tracing and root cause debugger.',
    allowedTools: ['run_command', 'view_file', 'grep_search'],
  },
}

export interface DispatchedTask {
  taskId: string
  childSessionId: string
  parentSessionId: string
  role: AgentRole
  persona: string
  dispatchedAt: number
  forked: boolean
}

export class DispatchPipeline {
  private maxConcurrent: number
  private maxDepth: number

  constructor(maxConcurrent = 8, maxDepth = 2) {
    this.maxConcurrent = maxConcurrent
    this.maxDepth = maxDepth
  }

  /**
   * Stage 1: Admission (Concurrency, recursion depth and budget check)
   */
  public admit(currentConcurrent: number, depth: number, tokenBudget = 50000): { admitted: boolean; reason: string } {
    if (currentConcurrent >= this.maxConcurrent) {
      return { admitted: false, reason: `Concurrency limit reached (${currentConcurrent}/${this.maxConcurrent})` }
    }
    if (depth > this.maxDepth) {
      return { admitted: false, reason: `Max subagent recursion depth exceeded (${depth} > ${this.maxDepth})` }
    }
    if (tokenBudget <= 0) {
      return { admitted: false, reason: 'Insufficient token budget allocated' }
    }
    return { admitted: true, reason: 'Admitted' }
  }

  /**
   * Stage 2: Steer (Dynamic role specialization and tool narrowing)
   */
  public steer(taskPrompt: string, requestedRole?: AgentRole): RoleSpec {
    if (requestedRole && ROLE_SPECS[requestedRole]) {
      return ROLE_SPECS[requestedRole]
    }

    const p = taskPrompt.toLowerCase()
    if (p.includes('review') || p.includes('audit') || p.includes('check')) {
      return ROLE_SPECS.reviewer
    }
    if (p.includes('search') || p.includes('find') || p.includes('research') || p.includes('explore')) {
      return ROLE_SPECS.researcher
    }
    if (p.includes('plan') || p.includes('design') || p.includes('decompose')) {
      return ROLE_SPECS.planner
    }
    if (p.includes('diagnose') || p.includes('bug') || p.includes('error') || p.includes('trace')) {
      return ROLE_SPECS.diagnostician
    }

    return ROLE_SPECS.coder
  }

  /**
   * Stage 3: Dispatch (Session isolation & subagent fork snapshot dispatch)
   */
  public dispatch(
    taskId: string,
    roleSpec: RoleSpec,
    parentSessionId: string,
    fork = false
  ): DispatchedTask {
    const childSessionId = `subagent-${crypto.randomBytes(4).toString('hex')}`
    return {
      taskId,
      childSessionId,
      parentSessionId,
      role: roleSpec.role,
      persona: roleSpec.role,
      dispatchedAt: Date.now(),
      forked: fork,
    }
  }

  /**
   * Stage 4: Delivery (Acceptance Contract & Output Schema Verification)
   */
  public deliver(result: any, expectedFields: string[] = []): { valid: boolean; missing: string[] } {
    if (!result || typeof result !== 'object') {
      return { valid: false, missing: expectedFields }
    }
    const missing = expectedFields.filter((f) => !(f in result))
    return {
      valid: missing.length === 0,
      missing,
    }
  }
}
