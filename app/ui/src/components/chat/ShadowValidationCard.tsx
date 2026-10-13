import React, { useState } from 'react'
import { Layers, Check, X, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ShadowValidation } from '@apptypes/index'
import { useAgentStore } from '@store/agentStore'

export function ShadowValidationCard({ report }: { report: ShadowValidation }) {
  const { t } = useTranslation()
  const applyShadow = useAgentStore((s) => s.applyShadow)
  const discardShadow = useAgentStore((s) => s.discardShadow)
  const [busy, setBusy] = useState<'apply' | 'discard' | null>(null)

  const changes = report.changes?.length ?? report.paths?.length ?? 0
  const errors = report.error_count ?? report.issues?.filter((i) => i.severity === 'error').length ?? 0
  const warnings = report.warning_count ?? report.issues?.filter((i) => i.severity === 'warning').length ?? 0
  if (!changes && !report.issues?.length && report.ok !== false) return null

  const pending = report.pending_apply !== false && !report.applied?.length
  const border = errors > 0
    ? 'border-destructive/40 bg-destructive/5'
    : warnings > 0
      ? 'border-amber-500/30 bg-amber-500/5'
      : 'border-emerald-500/30 bg-emerald-500/5'

  const onApply = async () => {
    setBusy('apply')
    try {
      await applyShadow()
    } finally {
      setBusy(null)
    }
  }

  const onDiscard = async () => {
    setBusy('discard')
    try {
      await discardShadow()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex justify-center my-2.5 px-4">
      <div className={`max-w-xl w-full rounded-xl border px-3.5 py-2.5 text-xs ${border}`}>
        <div className="flex items-center gap-2 font-semibold mb-1.5">
          <Layers className="w-3.5 h-3.5 shrink-0" />
          <span>
            {report.ok
              ? t('store.shadow.titleOk', '影子工作区校验通过')
              : t('store.shadow.titleFail', '影子工作区发现问题')}
          </span>
          {changes > 0 && (
            <span className="text-muted-foreground font-normal">
              · {t('store.shadow.changes', '{{count}} 个文件待合并', { count: changes })}
            </span>
          )}
        </div>

        {(errors > 0 || warnings > 0) && (
          <div className="flex gap-3 text-[11px] text-muted-foreground mb-1.5">
            {errors > 0 && (
              <span className="text-destructive flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                {t('store.shadow.errors', '{{count}} 错误', { count: errors })}
              </span>
            )}
            {warnings > 0 && (
              <span>{t('store.shadow.warnings', '{{count}} 警告', { count: warnings })}</span>
            )}
          </div>
        )}

        <ul className="space-y-0.5 text-[11px] text-muted-foreground mb-2 max-h-32 overflow-y-auto">
          {(report.issues || []).slice(0, 8).map((issue, i) => (
            <li key={i} className="truncate">
              · {issue.path ? `${issue.path}${issue.line ? `:${issue.line}` : ''}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>

        {report.auto_apply_blocked && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400 mb-2">
            {t('store.shadow.autoBlocked', '自动合并已阻止：请先修复错误或手动确认。')}
          </p>
        )}

        {pending && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy !== null || !report.ok}
              onClick={onApply}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium disabled:opacity-40"
            >
              <Check className="w-3 h-3" />
              {busy === 'apply'
                ? t('store.shadow.applying', '合并中…')
                : t('store.shadow.apply', '接受并合并')}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={onDiscard}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-border text-[11px] font-medium disabled:opacity-40"
            >
              <X className="w-3 h-3" />
              {busy === 'discard'
                ? t('store.shadow.discarding', '丢弃中…')
                : t('store.shadow.discard', '丢弃改动')}
            </button>
          </div>
        )}

        {report.applied && report.applied.length > 0 && (
          <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
            {t('store.shadow.applied', '已合并 {{count}} 个文件', { count: report.applied.length })}
          </p>
        )}
      </div>
    </div>
  )
}
