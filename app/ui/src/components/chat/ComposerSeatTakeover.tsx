// src/components/chat/ComposerSeatTakeover.tsx
// Composer Seat Takeover for action approvals.
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, Check, X } from 'lucide-react'
import { useAgentStore } from '@store/agentStore'
import { cn } from '@lib/utils'

export function ComposerSeatTakeover() {
  const { t } = useTranslation()
  const toolCalls = useAgentStore((s) => s.toolCalls)
  const respondPermission = useAgentStore((s) => s.respondPermission)

  // Find the active confirmation call
  const activeConfirmCall = toolCalls.find((c) => c.status === 'needs_confirmation')

  // Keyboard shortcut for action confirmation
  useEffect(() => {
    if (!activeConfirmCall) return
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only if not actively typing multi-line in textarea
      if (e.key === 'Escape') {
        e.preventDefault()
        respondPermission(activeConfirmCall.id, 'deny')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeConfirmCall, respondPermission])

  if (!activeConfirmCall) return null

  const isCritical = activeConfirmCall.riskLevel === 'critical'
  const toolName = activeConfirmCall.toolName || '工具执行'
  const args = activeConfirmCall.args || {}
  const cmd = String(args.command || args.CommandLine || args.cmd || args.path || args.TargetFile || '')
  const snippet = cmd.length > 45 ? cmd.slice(0, 45) + '…' : cmd

  return (
    <div className={cn(
      'flex items-center justify-between gap-2 px-3 py-2 border-b text-xs animate-in fade-in slide-in-from-top-1 duration-200',
      isCritical ? 'bg-destructive/10 border-destructive/25 text-destructive' : 'bg-warning/10 border-warning/25 text-warning-foreground'
    )}>
      <div className="flex items-center gap-1.5 min-w-0">
        <ShieldAlert size={14} className="shrink-0 text-warning" />
        <span className="font-medium text-foreground truncate">
          {t('approval.needsPermission', '等待操作授权')}:
        </span>
        <span className="px-1.5 py-0.2 rounded bg-muted font-mono text-[10px] text-foreground border border-border/50 truncate max-w-[220px]">
          {snippet || toolName}
        </span>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={() => respondPermission(activeConfirmCall.id, 'approve')}
          className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] font-medium bg-foreground text-background hover:bg-foreground/90 transition-colors press-feedback"
        >
          <Check size={11} />
          <span>{t('approval.approve', '允许 (Enter)')}</span>
        </button>
        <button
          type="button"
          onClick={() => respondPermission(activeConfirmCall.id, 'deny')}
          className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] font-medium bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors press-feedback"
        >
          <X size={11} />
          <span>{t('approval.deny', '拒绝 (Esc)')}</span>
        </button>
      </div>
    </div>
  )
}
