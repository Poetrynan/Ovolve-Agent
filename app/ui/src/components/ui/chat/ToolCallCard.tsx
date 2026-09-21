/**
 * ToolCallCard — collapsible tool invocation card (TOOL_UI_UX.md §5.2).
 *
 * Shows the tool name, status, risk badge and duration in the header; the body
 * (input args + output preview) expands on click. The card lives outside the
 * chat bubble so a multi-step turn reads as a chronology, not a nested block.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  MessageCircleQuestion,
  ShieldAlert,
  Wrench,
  XCircle,
} from 'lucide-react'
import { OvolveLoader } from '@/components/ui/OvolveLoader'
import { Badge } from '@components/ui/badge'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@store/agentStore'
import type { ChatDensity } from '@store/sessionConfigStore'
import type { ToolCall } from '@apptypes/index'
import { AskUserPanel } from './AskUserPanel'
import {
  FileBody,
  SearchBody,
  TerminalBody,
  toolKindOf,
} from './toolRenderers'

export interface ToolCallCardProps {
  toolCall: ToolCall
  /** Force expanded state (defaults to auto-collapse on success). */
  defaultExpanded?: boolean
  /** Timeline density from the composer — compact/minimal collapse quiet rows. */
  density?: ChatDensity
}

const STATUS_LABEL: Record<ToolCall['status'], string> = {
  pending: '排队中',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  denied: '已拒绝',
  needs_confirmation: '待确认',
  needs_input: '等你回答',
  interrupted: '已中断',
}

function StatusIcon({ status }: { status: ToolCall['status'] }) {
  const base = 'h-3.5 w-3.5 shrink-0'
  switch (status) {
    case 'completed':
      return <CheckCircle2 className={cn(base, 'text-success')} />
    case 'failed':
      return <XCircle className={cn(base, 'text-destructive')} />
    case 'denied':
    case 'needs_confirmation':
      return <ShieldAlert className={cn(base, 'text-warning')} />
    case 'needs_input':
      // Not a warning — nothing is blocked, the agent is just waiting on a
      // preference. A shield here would read as "something went wrong".
      return <MessageCircleQuestion className={cn(base, 'text-primary')} />
    case 'running':
      return <span className={cn(base, 'inline-flex items-center justify-center')}><OvolveLoader size={15} strokeWidth={24} /></span>
    case 'interrupted':
      // The turn died before this call reported back. A static slash reads as
      // "never finished" without implying the tool itself errored.
      return <CircleSlash className={cn(base, 'text-muted-foreground')} />
    default:
      return <Wrench className={cn(base, 'text-muted-foreground')} />
  }
}

function formatDuration(tc: ToolCall): string | null {
  if (!tc.completedAt || !tc.timestamp) return null
  const ms = Math.max(0, (tc.completedAt - tc.timestamp) * 1000)
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function ArgsPreview({ args }: { args: Record<string, any> }) {
  const entries = Object.entries(args || {}).slice(0, 5)
  if (!entries.length) return null
  return (
    <dl className="space-y-1 text-[11px]">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <dt className="text-muted-foreground shrink-0">{k}</dt>
          <dd className="font-mono text-foreground/80 break-all line-clamp-2">
            {typeof v === 'string' ? v : JSON.stringify(v)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The three answers to a parked confirmation.
 *
 * Rendered OUTSIDE the collapsible body on purpose: a question you have to
 * expand a card to find is a question people miss, and a missed confirmation
 * reads as the agent having silently stalled.
 *
 * 「以后都允许」 is the one that changes throughput — it leaves a standing
 * allowlist rule so the same class of call stops asking. The backend refuses to
 * write that rule for irreversible steps, so offering it here is safe; a
 * critical call simply asks again next time.
 */
function ApprovalBar({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation()
  const respond = useAgentStore((s) => s.respondPermission)
  const critical = toolCall.riskLevel === 'critical'
  return (
    <div className="border-t border-warning/30 bg-warning/5 px-3 py-2 flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-muted-foreground mr-auto">
        {critical ? t('approval.needIrreversible') : t('approval.need')}
      </span>
      <button
        type="button"
        onClick={() => respond(toolCall.id, 'deny')}
        className="h-6 px-2 rounded-md text-[11px] text-muted-foreground hover:bg-foreground/5 transition-colors"
      >
        {t('approval.deny')}
      </button>
      {!critical && (
        <button
          type="button"
          onClick={() => respond(toolCall.id, 'approve_always')}
          title={t('approval.alwaysHint')}
          className="h-6 px-2 rounded-md text-[11px] text-foreground border border-border/60 hover:bg-accent transition-colors"
        >
          {t('approval.always')}
        </button>
      )}
      <button
        type="button"
        onClick={() => respond(toolCall.id, 'approve')}
        className="h-6 px-2.5 rounded-md text-[11px] font-medium bg-foreground text-background hover:opacity-90 transition-opacity"
      >
        {t('approval.approve')}
      </button>
    </div>
  )
}

export function ToolCallCard({ toolCall, defaultExpanded, density = 'full' }: ToolCallCardProps) {
  const { t } = useTranslation()
  const compactRow = density !== 'full' && toolCall.status === 'completed'
  // Open while it runs (that's when the live output is worth watching), then fold
  // itself away once it succeeds. Only the initial value used to be computed,
  // so a card that mounted as `running` stayed open forever — after a ten-step
  // turn the feed was a wall of finished output.
  //
  // Failures stay open: the reason it broke is the thing you came to read.
  const auto = toolCall.status !== 'completed'
  const [expanded, setExpanded] = useState(defaultExpanded ?? auto)
  // Once the user has an opinion, we stop having one. Nothing is more annoying
  // than a panel that closes itself while you are reading it.
  const pinned = useRef(defaultExpanded !== undefined)
  useEffect(() => {
    if (pinned.current) return
    if (toolCall.status === 'completed') setExpanded(false)
    else if (toolCall.status === 'failed' || toolCall.status === 'denied') setExpanded(true)
  }, [toolCall.status])
  const duration = formatDuration(toolCall)

  if (compactRow) {
    return (
      <div className="flex items-center gap-2 py-0.5 text-[11px] text-muted-foreground font-mono">
        <CheckCircle2 className="h-3 w-3 shrink-0 text-success/80" />
        <code className="truncate">{toolCall.toolName}</code>
        {duration && <span className="shrink-0 opacity-70">· {duration}</span>}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'rounded-xl border text-xs bg-card/60 backdrop-blur-sm transition-all duration-200 overflow-hidden',
        toolCall.status === 'failed' && 'border-destructive/50 bg-destructive/5',
        toolCall.status === 'denied' && 'border-warning/50 bg-warning/5',
        toolCall.status === 'running' && 'border-primary/40 shadow-xs ring-1 ring-primary/20',
        toolCall.status === 'completed' && 'border-border/40 hover:border-border/60 hover:bg-card/80',
      )}
    >
      <button
        type="button"
        onClick={() => {
          pinned.current = true
          setExpanded((e) => !e)
        }}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left select-none transition-colors"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out-strong',
            expanded && 'rotate-90',
          )}
        />
        <StatusIcon status={toolCall.status} />
        <div className="flex items-center gap-1.5 min-w-0">
          <code className="font-mono font-medium text-[11.5px] text-foreground/90">{toolCall.toolName}</code>
          {toolCall.riskLevel && toolCall.riskLevel !== 'low' && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 uppercase font-mono font-normal border-warning/40 text-warning">
              {toolCall.riskLevel}
            </Badge>
          )}
          {toolCall.reversible === false && (
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 h-4 border-warning/40 text-warning/90 font-normal"
              title="此步骤不可逆"
            >
              不可逆
            </Badge>
          )}
          {toolCall.askAutoResolved && (
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 h-4 border-primary/40 text-primary font-normal"
              title={t('askUser.autoHint')}
            >
              {t('askUser.auto')}
            </Badge>
          )}
        </div>
        <span className="ml-auto text-muted-foreground/70 text-[11px] font-mono flex items-center gap-1.5">
          <span className={cn(toolCall.status === 'running' && 'text-primary font-medium')}>
            {STATUS_LABEL[toolCall.status]}
          </span>
          {duration && <span className="opacity-60">· {duration}</span>}
        </span>
      </button>

      {/* The ask lives here, not inside the fold: a parked confirmation the user
          has to expand to answer is one they'll read as a silent stall. */}
      {toolCall.status === 'needs_confirmation' && <ApprovalBar toolCall={toolCall} />}
      {toolCall.status === 'needs_input' && <AskUserPanel toolCall={toolCall} />}

      {expanded && (
        <div className="border-t border-border/40 px-3 py-2 space-y-2 motion-safe:animate-fade-in">
          {/* Specialized body renders first when available; generic args/result below. */}
          {toolKindOf(toolCall.toolName) === 'terminal' ? (
            <TerminalBody toolCall={toolCall} />
          ) : toolKindOf(toolCall.toolName) === 'file' ? (
            <FileBody toolCall={toolCall} />
          ) : toolKindOf(toolCall.toolName) === 'search' ? (
            <SearchBody toolCall={toolCall} />
          ) : (
            <>
              <ArgsPreview args={toolCall.args} />
              {toolCall.result != null && (
                <div className="text-[11px]">
                  <div className="text-muted-foreground mb-1">
                    {toolCall.status === 'failed' || toolCall.status === 'denied'
                      ? '错误'
                      : '输出预览'}
                  </div>
                  <pre
                    className={cn(
                      'font-mono whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-foreground/80 max-h-32 overflow-auto',
                      toolCall.status === 'failed' && 'text-destructive/90',
                    )}
                  >
                    {String(toolCall.result)}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
