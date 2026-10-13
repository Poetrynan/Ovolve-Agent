// Backend-resolved thinking capability for the active model (single source of truth).
import { useEffect, useState } from 'react'
import { API_BASE, apiFetch } from '@lib/api'
import { resolveReasoningToggle } from '@lib/modelCapabilities'
import type { ModelDef } from '@store/modelStore'

export interface ThinkingCapability {
  showDial: boolean
  variants: string[]
  source: string
  confidence: number
  loading: boolean
}

interface ResolveBody {
  thinkingCapability?: {
    ui?: { showDial?: boolean; variants?: string[] }
    thinking?: { source?: string; confidence?: number }
  }
}

export function useResolvedThinkingCapability(
  modelKey: string,
  modelDef: ModelDef | undefined,
  modelId: string,
): ThinkingCapability {
  const [cap, setCap] = useState<ThinkingCapability>({
    showDial: false,
    variants: [],
    source: 'none',
    confidence: 0,
    loading: !!modelKey,
  })

  useEffect(() => {
    if (!modelKey) {
      setCap({ showDial: false, variants: [], source: 'none', confidence: 0, loading: false })
      return
    }

    let cancelled = false
    setCap((prev) => ({ ...prev, loading: true }))

    apiFetch(`${API_BASE}/api/models/resolve?model=${encodeURIComponent(modelKey)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json() as Promise<ResolveBody>
      })
      .then((body) => {
        if (cancelled) return
        const tc = body.thinkingCapability
        const ui = tc?.ui
        setCap({
          showDial: !!ui?.showDial,
          variants: Array.isArray(ui?.variants) ? ui!.variants! : [],
          source: tc?.thinking?.source ?? 'registry',
          confidence: Number(tc?.thinking?.confidence) || 0,
          loading: false,
        })
      })
      .catch(() => {
        if (cancelled) return
        const fallback = resolveReasoningToggle(modelDef, modelId)
        setCap({
          showDial: !!fallback?.enabled,
          variants: fallback?.variants ?? [],
          source: 'offline_fallback',
          confidence: fallback ? 0.5 : 0,
          loading: false,
        })
      })

    return () => {
      cancelled = true
    }
  }, [modelKey, modelDef, modelId])

  return cap
}
