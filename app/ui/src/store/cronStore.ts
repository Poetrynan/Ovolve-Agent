import { create } from 'zustand'
import { API_BASE, apiFetch } from '@lib/api'
import { CronJob } from '@apptypes/index'

interface CronState {
  crons: CronJob[]
  loading: boolean
  /** 最近一次 fetchCrons 是否失败：让 UI 能区分"没有任务"和"读取失败"。 */
  lastFetchFailed: boolean
  fetchCrons: () => Promise<void>
  createCron: (expression: string, taskName: string, taskData?: Record<string, any>) => Promise<void>
  updateCron: (id: string, status: string) => Promise<void>
  deleteCron: (id: string) => Promise<void>
}

export const useCronStore = create<CronState>((set) => ({
  crons: [],
  loading: false,
  lastFetchFailed: false,

  fetchCrons: async () => {
    set({ loading: true })
    try {
      const response = await apiFetch(`${API_BASE}/api/crons`)
      if (response.ok) {
        const data = await response.json()
        set({ crons: data.crons || [], loading: false, lastFetchFailed: false })
      } else {
        set({ loading: false, lastFetchFailed: true })
      }
    } catch {
      set({ loading: false, lastFetchFailed: true })
    }
  },

  createCron: async (expression: string, taskName: string, taskData?: Record<string, any>) => {
    const response = await apiFetch(`${API_BASE}/api/crons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression, taskName, taskData: taskData || {} }),
    })
    if (response.ok) {
      const cron = await response.json() as CronJob
      set(state => ({ crons: [...state.crons, cron] }))
    }
  },

  updateCron: async (id: string, status: string) => {
    const response = await apiFetch(`${API_BASE}/api/crons/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (response.ok) {
      set(state => ({
        crons: state.crons.map(c => c.id === id ? { ...c, status: status as CronJob['status'] } : c)
      }))
    }
  },

  deleteCron: async (id: string) => {
    const response = await apiFetch(`${API_BASE}/api/crons/${id}`, { method: 'DELETE' })
    if (response.ok) {
      set(state => ({ crons: state.crons.filter(c => c.id !== id) }))
    }
  },
}))
