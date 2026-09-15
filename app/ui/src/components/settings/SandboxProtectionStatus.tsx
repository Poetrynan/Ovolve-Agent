import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ShieldAlert, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@components/ui/collapsible'

export interface ConfinementSnapshot {
  effective: boolean
  level?: string
  backend?: string
  note?: string
  policy_source?: string
}

interface SandboxProtectionStatusProps {
  confinement: ConfinementSnapshot | null
  /** Legacy policy-layer flag; only surfaced when kernel confinement is off. */
  sandbox?: { effective: boolean; note: string } | null
}

type StatusVariant = 'ok' | 'warn'

export function SandboxProtectionStatus({ confinement, sandbox }: SandboxProtectionStatusProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const view = useMemo(() => {
    if (!confinement) return null

    const customPolicy = confinement.policy_source && confinement.policy_source !== 'built-in'
    const policyHint = customPolicy
      ? t('settingsPage.sandboxStatus.customPolicy')
      : t('settingsPage.sandboxStatus.defaultPolicy')

    if (confinement.effective) {
      const partial = confinement.level === 'partial'
      return {
        variant: 'ok' as StatusVariant,
        title: partial
          ? t('settingsPage.sandboxStatus.partialTitle')
          : t('settingsPage.sandboxStatus.fullTitle'),
        desc: partial
          ? t('settingsPage.sandboxStatus.partialDesc', { policy: policyHint })
          : t('settingsPage.sandboxStatus.fullDesc', { policy: policyHint }),
        badge: partial
          ? t('settingsPage.sandboxStatus.badgePartial')
          : t('settingsPage.sandboxStatus.badgeOn'),
      }
    }

    return {
      variant: 'warn' as StatusVariant,
      title: t('settingsPage.sandboxStatus.offTitle'),
      desc: t('settingsPage.sandboxStatus.offDesc', { policy: policyHint }),
      badge: t('settingsPage.sandboxStatus.badgeOff'),
    }
  }, [confinement, t])

  const showLegacySandbox = sandbox && !sandbox.effective && !confinement?.effective

  if (!view && !showLegacySandbox) return null

  return (
    <div className="mb-5 space-y-3">
      {view && (
        <div
          role="status"
          className={cn(
            'flex items-center gap-3 rounded-xl border px-4 py-3 bg-card/80',
            view.variant === 'ok' ? 'border-border/60' : 'border-amber-500/25 bg-amber-500/5',
          )}
        >
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              view.variant === 'ok' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
            )}
          >
            {view.variant === 'ok' ? (
              <ShieldCheck className="h-4 w-4" aria-hidden />
            ) : (
              <ShieldAlert className="h-4 w-4" aria-hidden />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{view.title}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{view.desc}</p>
          </div>
          <span
            className={cn(
              'shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              view.variant === 'ok'
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
            )}
          >
            {view.badge}
          </span>
        </div>
      )}

      {showLegacySandbox && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-xs leading-relaxed text-muted-foreground">{sandbox.note}</p>
        </div>
      )}

      {confinement && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>{t('settingsPage.sandboxStatus.techDetails')}</span>
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1 rounded-lg border border-border/40 bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              {confinement.backend ? (
                <p className="font-mono">
                  {confinement.backend}
                  {confinement.level ? ` · ${confinement.level}` : ''}
                  {confinement.policy_source && confinement.policy_source !== 'built-in'
                    ? ` · ${confinement.policy_source}`
                    : ''}
                </p>
              ) : null}
              <p className="mt-2">{t('settingsPage.sandboxStatus.policyFileHint')}</p>
              <ul className="mt-1.5 space-y-0.5 font-mono text-[10px]">
                <li>{t('settingsPage.sandboxPolicyPathWorkspace')}</li>
                <li>{t('settingsPage.sandboxPolicyPathDot')}</li>
                <li>{t('settingsPage.sandboxPolicyPathHome')}</li>
              </ul>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
