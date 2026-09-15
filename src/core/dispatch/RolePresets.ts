/**
 * RolePresets.ts — Subagent Team Role Presets & ResultContract Schemas
 *
 * Implements 8 canonical RoleSpec configurations:
 * 1. planner (plan list, 60k budget)
 * 2. researcher (findings list, 120k budget)
 * 3. coder (patch_summary string, 200k budget)
 * 4. reviewer (verdict string, issues list, 80k budget)
 * 5. validator (passed boolean, evidence list, 80k budget)
 * 6. memory_curator (proposals list, 40k budget)
 * 7. explore (findings list, 60k budget)
 * 8. diagnostician (observations list, 50k budget)
 */

export interface ResultSchema {
  required?: string[]
  types?: Record<string, 'string' | 'array' | 'object' | 'boolean' | 'number' | StringConstructor | ArrayConstructor | ObjectConstructor | BooleanConstructor | NumberConstructor>
}

export interface RolePreset {
  tools: string[]
  budget_tokens: number
  result_schema: ResultSchema
  system_prompt: string
  description?: string
}

export interface RoleSpec {
  role: string
  tools: string[]
  budget_tokens: number
  result_schema: ResultSchema
  deadline_s: number
  system_prompt: string
}

export const ROLE_PRESETS: Record<string, RolePreset> = {
  planner: {
    tools: [
      'read_text',
      'search_code',
      'find_files',
      'list_dir',
      'get_file_info',
      'goal_plan_create',
      'goal_plan_update',
    ],
    budget_tokens: 60000,
    result_schema: {
      required: ['plan'],
      types: { plan: 'array' },
    },
    system_prompt:
      'You are the Planner agent. Your responsibility is to analyze high-level goals, decompose complex tasks into ordered subtasks, and construct verifiable execution DAGs. Always output your final plan as a structured "plan" list.',
    description: 'Decompose goals into ordered execution plans',
  },
  researcher: {
    tools: [
      'web_search',
      'web_fetch',
      'academic_search',
      'read_text',
      'search_code',
      'find_files',
      'list_dir',
      'get_file_info',
    ],
    budget_tokens: 120000,
    result_schema: {
      required: ['findings'],
      types: { findings: 'array' },
    },
    system_prompt:
      'You are the Researcher agent. Your responsibility is to perform deep technical investigation across codebase, docs, and web resources. Always provide evidence-backed "findings" in a structured list.',
    description: 'Investigate technical documentation and domain facts',
  },
  coder: {
    tools: [
      'read_file',
      'read_text',
      'write_file',
      'edit_file',
      'delete_file',
      'move_file',
      'copy_file',
      'git_status',
      'git_diff',
      'git_log',
      'git_add',
      'git_commit',
      'shell_executor',
      'python_executor',
    ],
    budget_tokens: 200000,
    result_schema: {
      required: ['patch_summary'],
      types: { patch_summary: 'string' },
    },
    system_prompt:
      'You are the Coder agent. Implement minimal, production-grade, and bug-free code modifications strictly within assigned scope. Return a concise "patch_summary" describing all changes.',
    description: 'Implement code modifications and verify compilation',
  },
  reviewer: {
    tools: [
      'read_text',
      'search_code',
      'find_files',
      'list_dir',
      'get_file_info',
      'diff_files',
      'git_status',
      'git_diff',
      'git_log',
    ],
    budget_tokens: 80000,
    result_schema: {
      required: ['verdict', 'issues'],
      types: { verdict: 'string', issues: 'array' },
    },
    system_prompt:
      'You are the Reviewer agent. Rigorously inspect code diffs and implementations for logical flaws, edge case regressions, and security vulnerabilities. Return a "verdict" ("approved", "changes_requested", or "rejected") and an "issues" list.',
    description: 'Audit code diffs, quality, and edge case correctness',
  },
  validator: {
    tools: [
      'read_text',
      'search_code',
      'find_files',
      'list_dir',
      'get_file_info',
      'diff_files',
      'git_status',
      'git_diff',
      'shell_executor',
      'python_executor',
    ],
    budget_tokens: 80000,
    result_schema: {
      required: ['passed', 'evidence'],
      types: { passed: 'boolean', evidence: 'array' },
    },
    system_prompt:
      'You are the Validator agent. Run test suites, compile targets, and verify end-to-end acceptance criteria. Return "passed" (boolean) and a concrete "evidence" list.',
    description: 'Execute unit/integration tests and verify behavioral contracts',
  },
  memory_curator: {
    tools: ['read_text', 'list_dir', 'memory_query', 'memory_store'],
    budget_tokens: 40000,
    result_schema: {
      required: ['proposals'],
      types: { proposals: 'array' },
    },
    system_prompt:
      'You are the Memory Curator agent. Extract project facts, user preferences, and operational lessons from completed sessions. Output structured memory "proposals" for long-term retention.',
    description: 'Extract and consolidate long-term knowledge and preferences',
  },
  explore: {
    tools: [
      'read_text',
      'search_code',
      'find_files',
      'list_dir',
      'get_file_info',
      'diff_files',
      'git_status',
      'git_diff',
      'git_log',
    ],
    budget_tokens: 60000,
    result_schema: {
      required: ['findings'],
      types: { findings: 'array' },
    },
    system_prompt:
      'You are the Explore agent. Fast-survey directory layouts, architecture boundaries, and module relationships. Return structured "findings".',
    description: 'Fast codebase exploration and dependency mapping',
  },
  diagnostician: {
    tools: [
      'read_text',
      'search_code',
      'find_files',
      'list_dir',
      'get_file_info',
      'git_status',
      'git_diff',
      'git_log',
      'diagnose',
    ],
    budget_tokens: 50000,
    result_schema: {
      required: ['observations'],
      types: { observations: 'array' },
    },
    system_prompt:
      'You are the Diagnostician agent. Trace execution failures, diagnose crash logs and exceptions, and isolate root causes. Output structured "observations".',
    description: 'Trace failures, inspect error dumps, and locate root causes',
  },
}

export function roleSpec(role: string, overrides?: Partial<RoleSpec>): RoleSpec {
  const base = ROLE_PRESETS[role] || {
    tools: [],
    budget_tokens: 50000,
    result_schema: { required: ['summary'], types: { summary: 'string' } },
    system_prompt: `You are a specialized subagent executing tasks under the ${role || 'general'} role. Deliver clean, structured results.`,
    description: 'Generic fallback role',
  }

  return {
    role,
    tools: overrides?.tools ? [...overrides.tools] : [...base.tools],
    budget_tokens: overrides?.budget_tokens ? Number(overrides.budget_tokens) : base.budget_tokens,
    result_schema: overrides?.result_schema ? { ...overrides.result_schema } : { ...base.result_schema },
    deadline_s: overrides?.deadline_s ? Number(overrides.deadline_s) : 600,
    system_prompt: overrides?.system_prompt || base.system_prompt,
  }
}

/**
 * Validates a payload against a ResultContract schema.
 * Extra fields are permitted for forward compatibility.
 */
export function checkResultContract(
  payload: any,
  schema: ResultSchema,
): { ok: boolean; problems: string[] } {
  const problems: string[] = []

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      problems: [`payload must be a record object, got ${Array.isArray(payload) ? 'array' : typeof payload}`],
    }
  }

  const required = schema.required || []
  for (const key of required) {
    if (!(key in payload) || payload[key] === undefined || payload[key] === null) {
      problems.push(`missing required key: ${key}`)
    }
  }

  const types = schema.types || {}
  for (const [key, wantType] of Object.entries(types)) {
    if (key in payload && payload[key] !== undefined && payload[key] !== null) {
      const val = payload[key]
      const typeStr = typeof wantType === 'function' ? wantType.name.toLowerCase() : wantType

      if (typeStr === 'array' || wantType === Array) {
        if (!Array.isArray(val)) {
          problems.push(`key '${key}': expected array, got ${typeof val}`)
        }
      } else if (typeStr === 'boolean' || wantType === Boolean) {
        if (typeof val !== 'boolean') {
          problems.push(`key '${key}': expected boolean, got ${typeof val}`)
        }
      } else if (typeStr === 'number' || wantType === Number) {
        if (typeof val !== 'number' || Number.isNaN(val)) {
          problems.push(`key '${key}': expected number, got ${typeof val}`)
        }
      } else if (typeStr === 'string' || wantType === String) {
        if (typeof val !== 'string') {
          problems.push(`key '${key}': expected string, got ${typeof val}`)
        }
      } else if (typeStr === 'object' || wantType === Object) {
        if (typeof val !== 'object' || Array.isArray(val)) {
          problems.push(`key '${key}': expected object, got ${Array.isArray(val) ? 'array' : typeof val}`)
        }
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
  }
}

export const PERSONA_RESULT_SCHEMAS: Record<string, ResultSchema> = {
  'ResultContract.v1': { required: ['summary'], types: { summary: 'string' } },
  explore: { required: ['findings'], types: { findings: 'array' } },
  researcher: { required: ['findings'], types: { findings: 'array' } },
  reviewer: { required: ['verdict', 'issues'], types: { verdict: 'string', issues: 'array' } },
  planner: { required: ['plan'], types: { plan: 'array' } },
  coder: { required: ['patch_summary'], types: { patch_summary: 'string' } },
  validator: { required: ['passed', 'evidence'], types: { passed: 'boolean', evidence: 'array' } },
  verifier: { required: ['passed', 'evidence'], types: { passed: 'boolean', evidence: 'array' } },
  memory_curator: { required: ['proposals'], types: { proposals: 'array' } },
  diagnostician: { required: ['observations'], types: { observations: 'array' } },
}

export function getPersonaContract(personaName: string, resultSchemaName?: string): ResultSchema {
  if (resultSchemaName && PERSONA_RESULT_SCHEMAS[resultSchemaName]) {
    return PERSONA_RESULT_SCHEMAS[resultSchemaName]
  }
  if (personaName && PERSONA_RESULT_SCHEMAS[personaName]) {
    return PERSONA_RESULT_SCHEMAS[personaName]
  }
  return { required: ['summary'], types: { summary: 'string' } }
}

export interface SubagentResultItem {
  ok?: boolean
  type?: string
  label?: string
  text?: string
  payload?: any
  error?: string
  subagent_id?: string
  stale?: boolean
  mergeNote?: string
}

/**
 * Enforces ResultContract validation across a batch of subagent outputs.
 * Infers missing payload fields from text and rejects non-compliant or failed results.
 */
export function enforceContracts(results: SubagentResultItem[]): number {
  let rejected = 0

  for (const r of results) {
    if (!r || typeof r !== 'object' || !r.ok) {
      continue
    }

    const text = String(r.text || '').trim()
    const pType = String(r.type || '').trim().toLowerCase()
    const schema = getPersonaContract(pType)
    const payload = (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)) ? { ...r.payload } : {}

    if (!payload.summary && text) {
      payload.summary = text
    }

    if ((pType === 'explore' || pType === 'researcher') && !payload.findings) {
      const lines = text
        .split('\n')
        .map((l) => l.replace(/^[- *•]+\s*/, '').trim())
        .filter(Boolean)
      payload.findings = lines.length > 0 ? lines : [text]
    } else if (pType === 'planner' && !payload.plan) {
      const lines = text
        .split('\n')
        .map((l) => l.replace(/^[- *0-9.•]+\s*/, '').trim())
        .filter(Boolean)
      payload.plan = lines.length > 0 ? lines : [text]
    } else if (pType === 'reviewer') {
      if (!payload.verdict) {
        const lower = text.toLowerCase()
        const isPass = (lower.includes('pass') || lower.includes('ok') || text.includes('通过')) && !lower.includes('fail')
        payload.verdict = isPass ? 'approved' : 'changes_requested'
      }
      if (!payload.issues) {
        payload.issues = text
          .split('\n')
          .map((l) => l.replace(/^[- *•]+\s*/, '').trim())
          .filter((l) => {
            const low = l.toLowerCase()
            return low.includes('issue') || low.includes('error') || low.includes('warn') || low.includes('fix') || l.includes('问题') || l.includes('缺陷')
          })
      }
    } else if (pType === 'coder' && !payload.patch_summary) {
      payload.patch_summary = text
    } else if (pType === 'validator' || pType === 'verifier') {
      if (payload.passed === undefined) {
        const lower = text.toLowerCase()
        payload.passed =
          (lower.includes('pass') || lower.includes('ok') || text.includes('通过') || text.includes('成功')) &&
          !lower.includes('fail') &&
          !text.includes('失败')
      }
      if (!payload.evidence) {
        payload.evidence = text ? [text] : []
      }

      if (payload.passed === false) {
        r.ok = false
        r.error = `validator check failed: ${text || 'verification returned passed=false'}`
        rejected += 1
        r.payload = payload
        continue
      }
    } else if (pType === 'diagnostician' && !payload.observations) {
      const lines = text
        .split('\n')
        .map((l) => l.replace(/^[- *•]+\s*/, '').trim())
        .filter(Boolean)
      payload.observations = lines.length > 0 ? lines : [text]
    } else if (pType === 'memory_curator' && !payload.proposals) {
      const lines = text
        .split('\n')
        .map((l) => l.replace(/^[- *•]+\s*/, '').trim())
        .filter(Boolean)
      payload.proposals = lines.length > 0 ? lines : [text]
    }

    r.payload = payload

    const { ok, problems } = checkResultContract(payload, schema)
    if (!ok) {
      r.ok = false
      r.error = `result contract rejected: ${problems.join('; ')} (Delivery does not meet ResultContract schema standards)`
      rejected += 1
    }
  }

  return rejected
}
