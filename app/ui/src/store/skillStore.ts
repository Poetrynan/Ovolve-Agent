import { create } from 'zustand'
import { API_BASE, apiFetch } from '@lib/api'

export interface Skill {
  name: string
  description: string
  version: string
  status: string
  trust: string
}

interface SkillState {
  skills: Skill[]
  loading: boolean
  fetchSkills: () => Promise<void>
  importSkill: (path: string, trust: string) => Promise<void>
  enableSkill: (name: string) => Promise<void>
  disableSkill: (name: string) => Promise<void>
}

export const useSkillStore = create<SkillState>((set) => ({
  skills: [],
  loading: false,

  fetchSkills: async () => {
    set({ loading: true })
    try {
      const response = await apiFetch(`${API_BASE}/api/skills`)
      if (response.ok) {
        const data = await response.json()
        set({ skills: data.skills || [], loading: false })
      } else {
        set({ loading: false })
      }
    } catch {
      set({ loading: false })
    }
  },

  importSkill: async (path: string, trust: string) => {
    const response = await apiFetch(`${API_BASE}/api/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, trust }),
    })
    if (response.ok) {
      // Refresh skills after import
      set(state => state)
      const { fetchSkills } = useSkillStore.getState()
      await fetchSkills()
    }
  },

  enableSkill: async (name: string) => {
    const response = await apiFetch(`${API_BASE}/api/skills/${name}/enable`, { method: 'POST' })
    if (response.ok) {
      set(state => ({
        skills: state.skills.map(s => s.name === name ? { ...s, status: 'imported' } : s)
      }))
    }
  },

  disableSkill: async (name: string) => {
    const response = await apiFetch(`${API_BASE}/api/skills/${name}/disable`, { method: 'POST' })
    if (response.ok) {
      set(state => ({
        skills: state.skills.map(s => s.name === name ? { ...s, status: 'disabled' } : s)
      }))
    }
  },
}))
