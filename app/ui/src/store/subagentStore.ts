/**
 * subagentStore — the sub-agent personas the backend can actually spawn.
 *
 * Single source of truth is `app/backend/subagent_registry.py`; this store is a
 * cache of `GET /api/subagents/types`. The point of fetching rather than
 * hardcoding is that the registry merges YAML definitions from
 * `app/backend/subagents/*.yaml` — a user-added persona has to show up in the
 * `@` picker without a frontend release, or the two halves drift apart and the
 * picker starts offering personas the model has never heard of.
 *
 * Deliberately NOT persisted: capability boundaries are a backend fact, and a
 * stale localStorage copy claiming a persona is read-only when it isn't would
 * be worse than one extra fetch.
 */
import { create } from 'zustand'
import { API_BASE, apiFetch } from '@lib/api'

export interface SubagentType {
  name: string
  description: string
  /** null → full tool catalogue (write-capable). Array → read-only allowlist. */
  allowedTools: string[] | null
  permission: string
  model: string | null
  /** ``main`` | ``economy`` — ignored when ``model`` is set. */
  modelPolicy?: 'main' | 'economy'
  maxTurns: number | null
  /** Personas this one may delegate onward to. Empty → it is a leaf. */
  handoffs: string[]
}

interface SubagentTypeState {
  types: SubagentType[]
  loading: boolean
  /** True once a fetch has resolved (success or failure) — stops refetch loops. */
  loaded: boolean
  fetchTypes: () => Promise<void>
}

export const useSubagentStore = create<SubagentTypeState>((set, get) => ({
  types: [],
  loading: false,
  loaded: false,

  fetchTypes: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const res = await apiFetch(`${API_BASE}/api/subagents/types`)
      if (res.ok) {
        const data = await res.json()
        // Normalise here so the rest of the app never has to null-check backend
        // fields. An older backend (not yet restarted after a field was added)
        // omits `handoffs`; a raw `.handoffs.length` in a component would then
        // crash the whole page. Defaults belong at the trust boundary, once.
        const types: SubagentType[] = (data.types || []).map((t: any) => ({
          name: String(t?.name ?? ''),
          description: String(t?.description ?? ''),
          allowedTools: t?.allowedTools ?? null,
          permission: String(t?.permission ?? ''),
          model: t?.model ?? null,
          modelPolicy: t?.modelPolicy === 'economy' ? 'economy' : 'main',
          maxTurns: t?.maxTurns ?? null,
          handoffs: Array.isArray(t?.handoffs) ? t.handoffs : [],
        }))
        set({ types, loading: false, loaded: true })
      } else {
        set({ loading: false, loaded: true })
      }
    } catch {
      // Backend not up yet. `loaded` still flips so the caller falls back to
      // its built-in list instead of spinning forever.
      set({ loading: false, loaded: true })
    }
  },
}))

/**
 * Is this persona allowed to modify the workspace?
 *
 * `allowedTools === null` means "no allowlist" → full catalogue → can write.
 * Surfaced in the picker because "this one can edit my files" is the single
 * most important thing to know before delegating to it.
 */
export function isWriteCapable(t: SubagentType): boolean {
  return t.allowedTools === null
}
