// src/components/chat/ModelReadyBanner.tsx
// Persistent "no model configured" strip.
//
// # Why a strip and not a chat message
//
// Without an API key the backend does not fail — it silently falls back to a
// deterministic keyword matcher. You get *an* answer, so nothing looks broken,
// and you have no idea the model was never called. A chat message announcing
// this would scroll away and read as a one-time event; the condition is
// persistent, so the signal has to be persistent too.
//
// It also has to be actionable: the only useful response is "go configure a
// key", so the whole strip is the link.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { API_BASE, apiFetch } from '@lib/api'
import { useModelStore } from '@store/modelStore'
import { cn } from '@/lib/utils'

/**
 * `api_key_set` is only present in the settings payload when a key actually
 * exists (the backend masks the key itself and adds this flag), so `undefined`
 * and `false` both mean "not configured".
 */
async function fetchKeyConfigured(): Promise<boolean> {
  try {
    const r = await apiFetch(`${API_BASE}/api/settings`)
    if (!r.ok) return true // Can't tell — don't cry wolf.
    const d = await r.json()
    return !!d?.settings?.model?.api_key_set
  } catch {
    // Backend unreachable is a different problem with its own indicator
    // (the header connection dot); staying quiet here avoids double-reporting.
    return true
  }
}

export function ModelReadyBanner({ className }: { className?: string }) {
  const { t } = useTranslation()
  // `null` = still checking. Renders nothing so the banner never flashes on a
  // correctly-configured app.
  const [configured, setConfigured] = useState<boolean | null>(null)
  // The SAME source of truth the composer's pre-send guard uses. The backend's
  // config.json key and the Electron-side provider list are two different
  // stores; checking only the first made the strip cry "no model" even while
  // the composer had perfectly usable providers configured.
  const hasUsableModel = useModelStore((s) => s.enabledModels().length > 0)

  useEffect(() => {
    let alive = true
    void fetchKeyConfigured().then((ok) => {
      if (alive) setConfigured(ok)
    })
    // Re-check when the user comes back from the settings tab, so fixing the
    // key clears the strip without a reload.
    const onFocus = () => void fetchKeyConfigured().then((ok) => {
      if (alive) setConfigured(ok)
    })
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  if (configured !== false || hasUsableModel) return null

  return (
    <Link
      to="/settings"
      className={cn(
        'flex items-center gap-2 px-4 py-2 text-xs',
        'bg-warning/10 border-b border-warning/25 text-warning',
        'hover:bg-warning/15 transition-colors',
        className,
      )}
    >
      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
      <span className="font-medium">{t('modelReady.title')}</span>
      <span className="text-warning/80 truncate">{t('modelReady.detail')}</span>
      <ChevronRight className="w-3.5 h-3.5 ml-auto shrink-0 opacity-70" />
    </Link>
  )
}
