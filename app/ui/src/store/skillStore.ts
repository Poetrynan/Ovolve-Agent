import { create } from 'zustand'
import { API_BASE, apiFetch } from '@lib/api'

export interface Skill {
  name: string
  description: string
  version: string
  status: string
  trust: string
  title?: string
  category?: string
  author?: string
  stars?: number
  tags?: string[]
  triggers?: string[]
  requiresBins?: string[]
  requiresAnyBins?: string[]
  requiresReport?: any
  body?: string
}

interface SkillState {
  skills: Skill[]
  loading: boolean
  fetchSkills: () => Promise<void>
  importSkill: (path: string, trust: string) => Promise<void>
  enableSkill: (name: string) => Promise<void>
  disableSkill: (name: string) => Promise<void>
  uninstallSkill: (name: string) => Promise<boolean>
  getSkillDetail: (name: string) => Promise<any>
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

  uninstallSkill: async (name: string) => {
    try {
      const cleanName = name.replace(/^#/, '').trim()
      const response = await apiFetch(`${API_BASE}/api/skills/${encodeURIComponent(cleanName)}`, { method: 'DELETE' })
      if (response.ok) {
        // Safe deactivation: Retain card in UI list, mark as disabled so AI cannot use it
        set(state => ({
          skills: state.skills.map(s =>
            (s.name === cleanName || s.name === name)
              ? { ...s, status: 'disabled' }
              : s
          )
        }))
        return true
      }
      return false
    } catch {
      return false
    }
  },

  getSkillDetail: async (name: string) => {
    try {
      const cleanName = name.replace(/^#/, '').trim()
      const response = await apiFetch(`${API_BASE}/api/skills/${encodeURIComponent(cleanName)}`)
      if (response.ok) {
        const data = await response.json()
        return data.skill || null
      }
      return null
    } catch {
      return null
    }
  },
}))
