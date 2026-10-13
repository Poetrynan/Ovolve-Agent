import { create } from 'zustand'
import { API_BASE, apiFetch } from '@lib/api'

export interface BotMessage {
  id: string
  platform: string
  user_id: string
  content: string
  direction: string // 'inbound' | 'outbound'
  timestamp: number
}

/** What the backend can tell us about a platform without hitting the network. */
export interface PlatformStatus {
  platform: string
  configured: boolean
  listening: boolean
  allowedUsers: number
}

/** Per-platform config blob. Secrets come back masked (leading •). */
export type BotConfig = Record<string, any>

interface BotState {
  messages: BotMessage[]
  loading: boolean
  platform: string
  userId: string
  statuses: PlatformStatus[]
  config: BotConfig
  savingConfig: boolean
  sendError: string | null

  setPlatform: (platform: string) => void
  setUserId: (userId: string) => void
  fetchMessages: () => Promise<void>
  fetchStatuses: () => Promise<void>
  fetchConfig: (platform: string) => Promise<void>
  saveConfig: (platform: string, patch: BotConfig) => Promise<boolean>
  sendMessage: (content: string) => Promise<void>
}

export const useBotStore = create<BotState>((set, get) => ({
  messages: [],
  loading: false,
  platform: 'telegram',
  userId: 'default',
  statuses: [],
  config: {},
  savingConfig: false,
  sendError: null,

  setPlatform: (platform: string) => set({ platform }),
  setUserId: (userId: string) => set({ userId }),

  fetchMessages: async () => {
    const { platform, userId } = get()
    set({ loading: true })
    try {
      const res = await apiFetch(
        `${API_BASE}/api/bot/messages?platform=${platform}&user_id=${userId}`,
      )
      if (res.ok) {
        const data = await res.json()
        set({ messages: data.messages || [], loading: false })
      } else {
        set({ loading: false })
      }
    } catch {
      set({ loading: false })
    }
  },

  fetchStatuses: async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/bot/status`)
      if (res.ok) {
        const data = await res.json()
        set({ statuses: data.platforms || [] })
      }
    } catch {
      /* offline — leave statuses as-is */
    }
  },

  fetchConfig: async (platform: string) => {
    try {
      const res = await apiFetch(`${API_BASE}/api/bot/config/${platform}`)
      if (res.ok) {
        const data = await res.json()
        set({ config: data.config || {} })
      }
    } catch {
      set({ config: {} })
    }
  },

  saveConfig: async (platform: string, patch: BotConfig) => {
    set({ savingConfig: true })
    try {
      const res = await apiFetch(`${API_BASE}/api/bot/config/${platform}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      set({ savingConfig: false })
      if (res.ok) {
        await get().fetchStatuses()
        return true
      }
      return false
    } catch {
      set({ savingConfig: false })
      return false
    }
  },

  sendMessage: async (content: string) => {
    const { platform, userId } = get()
    set({ sendError: null })
    try {
      const res = await apiFetch(`${API_BASE}/api/bot/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, userId, content }),
      })
      if (res.ok) {
        await get().fetchMessages()
      } else {
        const data = await res.json().catch(() => ({}))
        set({ sendError: data.error || 'Send failed' })
      }
    } catch (e: any) {
      set({ sendError: e?.message || 'Network error' })
    }
  },
}))
