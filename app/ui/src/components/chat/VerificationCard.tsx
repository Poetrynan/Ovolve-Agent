/**
 * VerificationCard.tsx — Post-Edit Verification result display.
 *
 * Renders the result of running project verification commands (lint/typecheck/test/build)
 * after a file edit. Shows pass/fail status with expandable failure details.
 *
 * Pattern: mirror ShadowValidationCard (report prop + expandable panel).
 * Store: agentStore handles `post_edit_verification` event → messages[] as kind: 'verification'.
 */
import { useState } from 'react'
import { CheckCircle2, XCircle, ChevronDown, Loader2, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface VerificationReport {
  session_id: string
  workspace: string
  trigger_tool: string
  trigger_path: string
  success: boolean
  command: string
  kind: 'lint' | 'typecheck' | 'test' | 'build'
  exit_code: number
  output: string
  duration_ms: number
  timestamp: number
  error?: string
}

interface Props {
  report: VerificationReport
}

const KIND_LABELS: Record<string, string> = {
  lint: 'Lint',
  typecheck: 'Type Check',
  test: 'Test',
  build: 'Build',
}

export function VerificationCard({ report }: Props) {
  const [open, setOpen] = useState(false)
  const passed = report.success
  const failed = !report.success && !report.error
  const errored = !!report.error

  const borderClass = passed
    ? 'border-emerald-500/30'
    : failed
      ? 'border-rose-500/30'
      : 'border-amber-500/30'

  const iconClass = passed
    ? 'text-emerald-500'
    : failed
      ? 'text-rose-500'
      : 'text-amber-500'

  const statusText = passed
    ? `${KIND_LABELS[report.kind] || report.kind} 通过`
    : failed
      ? `${KIND_LABELS[report.kind] || report.kind} 未通过`
      : '验证出错'


  const detailText = passed
    ? `${report.duration_ms}ms · exit ${report.exit_code}`
    : failed
      ? `exit ${report.exit_code} · ${report.duration_ms}ms`
      : report.error || '未知错误'

  return (
    <div className="animate-message-in my-1">
      <div className={cn('mx-auto max-w-xl rounded-xl border bg-card/50', borderClass)}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        >
          {passed ? (
            <CheckCircle2 size={14} className={iconClass} />
          ) : failed ? (
            <XCircle size={14} className={iconClass} />
          ) : (
            <Loader2 size={14} className={cn(iconClass, 'animate-spin')} />
          )}
          <span className="font-medium">{statusText}</span>
          <span className="text-muted-foreground">·</span>
          <span className="truncate text-muted-foreground">{report.command}</span>
          <span className="ml-auto text-xs text-muted-foreground">{detailText}</span>
          <ChevronDown
            size={12}
            className={cn('text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        </button>

        {open && (
          <div className="border-t border-border/30 px-3 py-2">
            {report.trigger_path && (
              <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Terminal size={11} />
                <span className="truncate">{report.trigger_path}</span>
              </div>
            )}
            {report.output && (
              <pre className="max-h-40 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs leading-relaxed text-muted-foreground">
                {report.output}
              </pre>
            )}
            {report.error && !report.output && (
              <p className="text-xs text-amber-500">{report.error}</p>
            )}
            {passed && !report.output && (
              <p className="text-xs text-emerald-500/80">全部通过，无输出。</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
