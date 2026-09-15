/**
 * pluginStore — installed plugins and their contributions.
 *
 * Source of truth is `app/backend/plugin_registry.py`, surfaced through
 * `/api/plugins`. Not persisted: a plugin's status is a live property of the
 * backend process (a bundle whose skill file was deleted becomes `broken` on
 * the next boot), and a stale localStorage copy claiming a plugin is loaded
 * would be worse than one fetch.
 */
import { create } from 'zustand'
import { fetchJson, sendJson, API_BASE } from '@lib/api'

export interface Plugin {
  name: string
  root: string
  version: string
  /** 插件声明适配的宿主 API 契约版本（"1" | "2"）。旧后端无此字段 → undefined。 */
  apiVersion?: string
  description: string
  author: string
  homepage: string
  /** loaded → contributions are live; disabled → user turned it off;
   *  broken → nothing it declared could be applied (see `error`). */
  status: 'loaded' | 'disabled' | 'broken'
  /** Non-empty even when `loaded`: partial failures are reported, not hidden. */
  error: string
  /** Names actually registered right now. */
  skills: string[]
  subagents: string[]
  /** Manifest keys the backend does not apply — surfaced instead of ignored. */
  unsupported: string[]
  declaredSkills: number
  declaredSubagents: number
}

interface PluginState {
  plugins: Plugin[]
  loading: boolean
  loaded: boolean
  error: string
  fetchPlugins: () => Promise<void>
  importPlugin: (path: string) => Promise<boolean>
  setEnabled: (name: string, enabled: boolean) => Promise<void>
  removePlugin: (name: string) => Promise<void>
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  loading: false,
  loaded: false,
  error: '',

  fetchPlugins: async () => {
    set({ loading: true })
    try {
      const d = await fetchJson<{ plugins: any[] }>(`${API_BASE}/api/plugins`)
      // Normalise at the trust boundary: the array fields must BE arrays before
      // any component reads `.length` off them, or one missing key from an
      // older backend takes the whole page down instead of one card.
      const plugins: Plugin[] = (d.plugins || []).map((p: any) => ({
        name: String(p?.name ?? ''),
        root: String(p?.root ?? ''),
        version: String(p?.version ?? ''),
        apiVersion: p?.apiVersion != null ? String(p.apiVersion) : undefined,
        description: String(p?.description ?? ''),
        author: String(p?.author ?? ''),
        homepage: String(p?.homepage ?? ''),
        status: (p?.status ?? 'loaded') as Plugin['status'],
        error: String(p?.error ?? ''),
        skills: Array.isArray(p?.skills) ? p.skills : [],
        subagents: Array.isArray(p?.subagents) ? p.subagents : [],
        unsupported: Array.isArray(p?.unsupported) ? p.unsupported : [],
        declaredSkills: Number(p?.declaredSkills ?? 0),
        declaredSubagents: Number(p?.declaredSubagents ?? 0),
      }))
      set({ plugins, loading: false, loaded: true, error: '' })
    } catch (e: any) {
      set({ loading: false, loaded: true, error: e?.message || String(e) })
    }
  },

  importPlugin: async (path: string) => {
    set({ error: '' })
    try {
      await sendJson(`${API_BASE}/api/plugins/import`, 'POST', { path })
      await get().fetchPlugins()
      return true
    } catch (e: any) {
      set({ error: e?.message || String(e) })
      return false
    }
  },

  setEnabled: async (name: string, enabled: boolean) => {
    const verb = enabled ? 'enable' : 'disable'
    try {
      await sendJson(
        `${API_BASE}/api/plugins/${encodeURIComponent(name)}/${verb}`, 'POST',
      )
    } catch (e: any) {
      set({ error: e?.message || String(e) })
    }
    await get().fetchPlugins()
  },

  removePlugin: async (name: string) => {
    try {
      await sendJson(`${API_BASE}/api/plugins/${encodeURIComponent(name)}`, 'DELETE')
    } catch (e: any) {
      set({ error: e?.message || String(e) })
    }
    await get().fetchPlugins()
  },
}))
