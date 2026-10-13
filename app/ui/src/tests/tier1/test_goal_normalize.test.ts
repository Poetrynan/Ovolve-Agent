import { describe, it, expect } from 'vitest'
import { normalizeGoal } from '@lib/goalNormalize'

/**
 * Regression tests for the goals payload normalizer.
 *
 * The bug these lock down: GoalBudget guarded with `if (goal.costUsd <= 0)
 * return null`. When the API omitted `costUsd`, `undefined <= 0` evaluates to
 * false, so the guard did not fire and `goal.costUsd.toFixed(3)` threw
 * "Cannot read properties of undefined (reading 'toFixed')", blanking the whole
 * page. Normalizing at the store boundary means no renderer can ever see an
 * absent numeric field.
 */
describe('normalizeGoal', () => {
  it('fills every numeric field when the payload is empty', () => {
    const g = normalizeGoal({})
    expect(g.costUsd).toBe(0)
    expect(g.costCapUsd).toBe(0)
    expect(g.iteration).toBe(0)
    expect(g.tokensUsed).toBe(0)
    expect(g.subtasksTotal).toBe(0)
    expect(g.subtasksCompleted).toBe(0)
    // A missing ceiling must not become 0 — that would render a 0/0 counter
    // and make the iteration percentage divide by zero.
    expect(g.maxIterations).toBe(10)
  })

  it('produces a goal whose numeric fields all survive toFixed', () => {
    const g = normalizeGoal({ id: 'x', description: 'd' })
    expect(() => g.costUsd.toFixed(3)).not.toThrow()
    expect(() => g.costCapUsd.toFixed(2)).not.toThrow()
  })

  it('reads the camelCase shape the current backend sends', () => {
    const g = normalizeGoal({
      id: 'g1',
      description: 'write hello.txt',
      status: 'running',
      iteration: 3,
      maxIterations: 8,
      costUsd: 0.012,
      costCapUsd: 5,
      tokensUsed: 4321,
      subtasksCompleted: 2,
      subtasksTotal: 5,
      progressRatio: 0.4,
      lastError: '',
    })
    expect(g.status).toBe('running')
    expect(g.iteration).toBe(3)
    expect(g.maxIterations).toBe(8)
    expect(g.costUsd).toBe(0.012)
    expect(g.progressRatio).toBe(0.4)
    expect(g.subtasksTotal).toBe(5)
  })

  it('falls back to the snake_case shape an older backend serves', () => {
    // An unrestarted server returns the raw DB row. Rather than crashing, read
    // what is there.
    const g = normalizeGoal({
      id: 'g2',
      description: 'legacy row',
      status: 'active',
      iteration: 2,
      max_iterations: 4,
      last_error: 'boom',
      session_id: 's1',
      created_at: 1700000000,
    })
    expect(g.maxIterations).toBe(4)
    expect(g.lastError).toBe('boom')
    expect(g.sessionId).toBe('s1')
    expect(g.createdAt).toBe(1700000000)
    expect(g.costUsd).toBe(0)
  })

  it('nulls progressRatio when there is no plan to count against', () => {
    // A ratio without subtasks is meaningless — the UI must show a label, not
    // a bar. This is the same discipline that removed the hardcoded 25%.
    const g = normalizeGoal({ subtasksTotal: 0, progressRatio: 0.25 })
    expect(g.progressRatio).toBeNull()
  })

  it('keeps progressRatio when a plan exists', () => {
    const g = normalizeGoal({ subtasksTotal: 4, subtasksCompleted: 1, progressRatio: 0.25 })
    expect(g.progressRatio).toBe(0.25)
  })

  it('coerces non-numeric junk instead of propagating NaN', () => {
    const g = normalizeGoal({ costUsd: 'abc', iteration: null, maxIterations: 'x' })
    expect(g.costUsd).toBe(0)
    expect(g.iteration).toBe(0)
    expect(g.maxIterations).toBe(10)
    expect(Number.isNaN(g.costUsd)).toBe(false)
  })

  it('defaults plan to an array when the API sends a non-array', () => {
    expect(normalizeGoal({ plan: null }).plan).toEqual([])
    expect(normalizeGoal({ plan: 'oops' }).plan).toEqual([])
    expect(normalizeGoal({ plan: [{ id: '1', title: 't', status: 'pending' }] }).plan)
      .toHaveLength(1)
  })

  it('tolerates null and undefined payloads', () => {
    expect(() => normalizeGoal(null)).not.toThrow()
    expect(() => normalizeGoal(undefined)).not.toThrow()
    expect(normalizeGoal(null).id).toBe('')
  })
})
