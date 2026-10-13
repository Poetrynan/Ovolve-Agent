// src/components/chat/TurnRetryBanner.tsx
// Shown while the backend holds a failed turn open for graceSeconds. The user
// can retry with one click (same msgId) or wait for the countdown to expire.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, RotateCcw } from 'lucide-react'
import { useAgentStore } from '@store/agentStore'
import { Button } from '@components/ui/button'
import { cn } from '@lib/utils'

export function TurnRetryBanner({ className }: { className?: string }) {
  const { t } = useTranslation()
  const turnRetryWindow = useAgentStore((s) => s.turnRetryWindow)
  const retryTurn = useAgentStore((s) => s.retryTurn)
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    if (!turnRetryWindow) {
      setRemaining(0)
      return
    }
    const tick = () => {
      const elapsed = (Date.now() - turnRetryWindow.startedAt) / 1000
      setRemaining(Math.max(0, Math.ceil(turnRetryWindow.graceSeconds - elapsed)))
    }
    tick()
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [turnRetryWindow])

  if (!turnRetryWindow) return null

  return (
    <div
      role="status"
      className={cn(
        'mx-4 mt-3 rounded-2xl border px-3.5 py-3 text-xs',
        'border-amber-500/20 bg-amber-500/6 text-foreground',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-400">
          <AlertCircle className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{t('retryWindow.title')}</p>
            <span className="rounded-full border border-border/40 bg-background/70 px-2 py-0.5 text-[10px] font-mono tabular-nums text-muted-foreground">
              {t('retryWindow.countdown', { s: remaining })}
            </span>
          </div>
          <p className="mt-1 text-foreground/90">
            {turnRetryWindow.error || t('retryWindow.genericError')}
          </p>
          {turnRetryWindow.hint ? (
            <p className="mt-0.5 text-muted-foreground">{turnRetryWindow.hint}</p>
          ) : null}
          <div className="mt-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 rounded-xl text-xs"
              onClick={() => retryTurn()}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('retryWindow.retry')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
