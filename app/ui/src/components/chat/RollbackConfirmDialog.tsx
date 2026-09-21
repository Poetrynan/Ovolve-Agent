/**
 * RollbackConfirmDialog — the "are you sure" gate in front of an atomic withdraw.
 *
 * Withdrawing a turn now rolls back BOTH halves: the conversation history and
 * the files that turn changed on disk. That is a bigger action than the old
 * frontend-only edit, so it earns a confirmation — but only when there is
 * something real to warn about.
 *
 * The dialog's whole job is honesty about scope:
 *   - what will be restored (we snapshotted it, we can put it back)
 *   - what will NOT be restored (shell commands, pushes, commits) — listed by
 *     name, because "some things can't be undone" is useless advice
 *
 * When the span contains no tool calls at all there is nothing to disclose, so
 * `shouldConfirmWithdraw` returns false and the caller withdraws immediately.
 * A confirmation nobody needs is just a click tax.
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@components/ui/alert-dialog'
import type { ToolCall } from '@apptypes/index'

/** Tool calls that landed at or after `since` — i.e. inside the span being cut. */
export function toolCallsSince(toolCalls: ToolCall[], since: number): ToolCall[] {
  // Message and tool-call timestamps come off the same wire clock, so a plain
  // comparison is the honest correlation here. Tool calls are not linked to
  // message ids anywhere in the pipeline, so this is the association we have.
  return toolCalls.filter((tc) => tc.timestamp >= since)
}

export interface WithdrawImpact {
  /** Calls we can undo — snapshotted before they ran. */
  reversible: ToolCall[]
  /** Calls we cannot undo. These are what the dialog exists to disclose. */
  irreversible: ToolCall[]
}

export function assessWithdraw(toolCalls: ToolCall[], since: number): WithdrawImpact {
  const inSpan = toolCallsSince(toolCalls, since)
  return {
    reversible: inSpan.filter((tc) => tc.reversible !== false),
    irreversible: inSpan.filter((tc) => tc.reversible === false),
  }
}

/** Skip the dialog when the span touched nothing. */
export function shouldConfirmWithdraw(impact: WithdrawImpact): boolean {
  return impact.reversible.length > 0 || impact.irreversible.length > 0
}

export interface RollbackConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  impact: WithdrawImpact
  onConfirm: () => void
}

/** Dedupe by tool name, keeping a count, so 12 write_file calls read as one row. */
function summarize(calls: ToolCall[]): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const c of calls) counts.set(c.toolName, (counts.get(c.toolName) ?? 0) + 1)
  return [...counts.entries()].map(([name, count]) => ({ name, count }))
}

export function RollbackConfirmDialog({
  open,
  onOpenChange,
  impact,
  onConfirm,
}: RollbackConfirmDialogProps) {
  const { t } = useTranslation()
  const restorable = summarize(impact.reversible)
  const stuck = summarize(impact.irreversible)

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <RotateCcw size={16} className="text-muted-foreground" />
            {t('rollback.title')}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('rollback.description')}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-sm">
          {restorable.length > 0 && (
            <section>
              <h4 className="text-xs font-medium text-muted-foreground mb-1.5">
                {t('rollback.willRestore')}
              </h4>
              <ul className="space-y-1">
                {restorable.map(({ name, count }) => (
                  <li key={name} className="flex items-center gap-2 text-foreground/80">
                    <code className="font-mono text-[11px]">{name}</code>
                    {count > 1 && (
                      <span className="text-[10px] text-muted-foreground">×{count}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {stuck.length > 0 && (
            <section className="rounded-lg border border-warning/40 bg-warning/5 p-3">
              <h4 className="flex items-center gap-1.5 text-xs font-medium text-warning dark:text-warning mb-1.5">
                <AlertTriangle size={13} />
                {t('rollback.wontRestore')}
              </h4>
              <ul className="space-y-1">
                {stuck.map(({ name, count }) => (
                  <li key={name} className="flex items-center gap-2 text-foreground/80">
                    <code className="font-mono text-[11px]">{name}</code>
                    {count > 1 && (
                      <span className="text-[10px] text-muted-foreground">×{count}</span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {t('rollback.wontRestoreHint')}
              </p>
            </section>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t('rollback.confirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
