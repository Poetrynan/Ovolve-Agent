import { create } from 'zustand'
import { Goal } from '@apptypes/index'
import { API_BASE, apiFetch } from '@lib/api'
import { normalizeGoal } from '@lib/goalNormalize'

interface GoalState {
  goals: Goal[]
  activeGoalId: string | null
  loading: boolean
  /** Last backend error, surfaced in the UI instead of failing silently. */
  error: string | null
  /** Goal ids with an in-flight mutation, so buttons can disable themselves. */
  busyIds: string[]

  fetchGoals: () => Promise<void>
  createGoal: (description: string) => Promise<void>
  updateGoal: (id: string, updates: Partial<Goal>) => Promise<void>
  deleteGoal: (id: string) => Promise<void>
  runGoal: (id: string) => Promise<void>
  pauseGoal: (id: string) => Promise<void>
  /** Merge a `goal_state_change` WS event into local state. */
  applyStateChange: (goalId: string, status: string, extra?: Record<string, any>) => void
  setActiveGoal: (id: string | null) => void
  clearError: () => void
}

/**
 * Pull the error text out of a failed response.
 *
 * The previous store swallowed every non-OK response, which is how the pause
 * and complete buttons managed to look functional while doing nothing for so
 * long. Any failure now has to end up on screen.
 */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    return body?.error || fallback
  } catch {
    return `${fallback} (HTTP ${res.status})`
  }
}

export const useGoalStore = create<GoalState>((set, get) => ({
  goals: [],
  activeGoalId: null,
  loading: false,
  error: null,
  busyIds: [],

  clearError: () => set({ error: null }),

  fetchGoals: async () => {
    set({ loading: true })
    try {
      const res = await apiFetch(`${API_BASE}/api/goals`)
      if (!res.ok) {
        set({ error: await readError(res, 'Failed to load goals'), loading: false })
        return
      }
      const data = await res.json()
      set({
        goals: (Array.isArray(data?.goals) ? data.goals : []).map(normalizeGoal),
        loading: false,
        error: null,
      })
    } catch (e: any) {
      set({ error: e?.message || 'Network error', loading: false })
    }
  },

  createGoal: async (description: string) => {
    try {
      const res = await apiFetch(`${API_BASE}/api/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      })
      if (!res.ok) {
        set({ error: await readError(res, 'Failed to create goal') })
        return
      }
      const goal: Goal = normalizeGoal(await res.json())
      set(state => ({ goals: [goal, ...state.goals], error: null }))
    } catch (e: any) {
      set({ error: e?.message || 'Network error' })
    }
  },

  updateGoal: async (id: string, updates: Partial<Goal>) => {
    set(state => ({ busyIds: [...state.busyIds, id] }))
    try {
      const res = await apiFetch(`${API_BASE}/api/goals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!res.ok) {
        set({ error: await readError(res, 'Failed to update goal') })
        return
      }
      const fresh: Goal = normalizeGoal(await res.json())
      set(state => ({
        goals: state.goals.map(g => (g.id === id ? fresh : g)),
        error: null,
      }))
    } catch (e: any) {
      set({ error: e?.message || 'Network error' })
    } finally {
      set(state => ({ busyIds: state.busyIds.filter(b => b !== id) }))
    }
  },

  deleteGoal: async (id: string) => {
    set(state => ({ busyIds: [...state.busyIds, id] }))
    try {
      const res = await apiFetch(`${API_BASE}/api/goals/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        set({ error: await readError(res, 'Failed to delete goal') })
        return
      }
      set(state => ({ goals: state.goals.filter(g => g.id !== id), error: null }))
    } catch (e: any) {
      set({ error: e?.message || 'Network error' })
    } finally {
      set(state => ({ busyIds: state.busyIds.filter(b => b !== id) }))
    }
  },

  runGoal: async (id: string) => {
    set(state => ({ busyIds: [...state.busyIds, id] }))
    try {
      const res = await apiFetch(`${API_BASE}/api/goals/${id}/run`, { method: 'POST' })
      if (!res.ok) {
        set({ error: await readError(res, 'Failed to start goal') })
        return
      }
      const body = await res.json()
      if (body.goal) {
        set(state => ({
          goals: state.goals.map(g => (g.id === id ? normalizeGoal(body.goal) : g)),
          error: null,
        }))
      }
    } catch (e: any) {
      set({ error: e?.message || 'Network error' })
    } finally {
      set(state => ({ busyIds: state.busyIds.filter(b => b !== id) }))
    }
  },

  pauseGoal: async (id: string) => {
    set(state => ({ busyIds: [...state.busyIds, id] }))
    try {
      const res = await apiFetch(`${API_BASE}/api/goals/${id}/pause`, { method: 'POST' })
      if (!res.ok) {
        set({ error: await readError(res, 'Failed to pause goal') })
        return
      }
      const body = await res.json()
      if (body.goal) {
        set(state => ({
          goals: state.goals.map(g => (g.id === id ? normalizeGoal(body.goal) : g)),
          error: null,
        }))
      }
    } catch (e: any) {
      set({ error: e?.message || 'Network error' })
    } finally {
      set(state => ({ busyIds: state.busyIds.filter(b => b !== id) }))
    }
  },

  applyStateChange: (goalId, status, extra = {}) => {
    const known = get().goals.some(g => g.id === goalId)
    if (!known) {
      // A goal we've never seen finished somewhere else (bot, cron). Refetch
      // rather than synthesizing a half-populated row.
      void get().fetchGoals()
      return
    }
    set(state => ({
      goals: state.goals.map(g =>
        g.id === goalId
          ? {
              ...g,
              status: status as Goal['status'],
              iteration: typeof extra.iteration === 'number' ? extra.iteration : g.iteration,
              maxIterations:
                typeof extra.max_iterations === 'number' ? extra.max_iterations : g.maxIterations,
              // A ceiling that arrives here IS from the backend, so this is the
              // one place the flag can legitimately flip to true.
              maxIterationsKnown:
                typeof extra.max_iterations === 'number' && extra.max_iterations > 0
                  ? true
                  : g.maxIterationsKnown,
              lastError: typeof extra.error === 'string' ? extra.error
                : typeof extra.reason === 'string' ? extra.reason
                : g.lastError,
            }
          : g,
      ),
    }))
  },

  setActiveGoal: (id) => set({ activeGoalId: id }),
}))
