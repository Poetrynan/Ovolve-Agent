/**
 * SubagentActivityView — the drill-down transcript for ONE sub-agent.
 *
 * Renders the ordered timeline the store accumulates from `subagent_activity`
 * frames: the child's narration and reasoning interleaved with the tool calls
 * they refer to, each tool a single line that goes running → completed exactly
 * like the main activity feed. This is the "see what the agent actually did"
 * surface the roster row links to.
 *
 * Shared by two hosts — expanded inline under a SubagentPanel row, and inside
 * the workspace SidePanel's 子代理 tab — so it takes only a `subagentId` and
 * reads everything else from the store. No host-specific state lives here.
 */
import { useTranslation } from 'react-i18next'
import { CheckCircle2, ChevronRight, Loader2, XCircle, Wrench } from 'lucide-react'
import { useAgentStore } from '@store/agentStore'
import type { SubagentToolCall } from '@apptypes/index'

function ToolRow({ tc }: { tc: SubagentToolCall }) {
  const running = tc.status === 'running'
  const failed = tc.status === 'error' || tc.ok === false
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="mt-0.5 shrink-0">
        {running ? (
          <Loader2 className="h-3 w-3 text-foreground animate-spin" />
        ) : failed ? (
          <XCircle className="h-3 w-3 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3 w-3 text-success" />
        )}
      </span>
      <Wrench className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="text-xs font-mono text-foreground">{tc.toolName || '?'}</span>
        {tc.preview && (
          <span className="ml-2 text-[11px] text-muted-foreground break-all">
            {tc.preview}
          </span>
        )}
      </div>
    </div>
  )
}

export function SubagentActivityView({ subagentId }: { subagentId: string }) {
  const { t } = useTranslation()
  const activity = useAgentStore((s) => s.subagentActivity[subagentId])

  if (!activity || activity.entries.length === 0) {
    return (
      <div className="px-3 py-4 text-[11px] text-muted-foreground">
        {t('subagentActivity.empty')}
      </div>
    )
  }

  return (
    <div className="px-3 py-2 space-y-1.5">
      {activity.truncated && (
        <div className="text-[11px] text-muted-foreground italic">
          {t('subagentActivity.truncated')}
        </div>
      )}
      {activity.entries.map((e, i) => {
        if (e.kind === 'text') {
          return (
            <p key={i} className="text-xs text-foreground/90 whitespace-pre-wrap break-words leading-relaxed">
              {e.text}
            </p>
          )
        }
        if (e.kind === 'reasoning') {
          return (
            <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground italic">
              <ChevronRight className="h-3 w-3 mt-0.5 shrink-0 opacity-60" />
              <span className="whitespace-pre-wrap break-words leading-relaxed">{e.text}</span>
            </div>
          )
        }
        return <ToolRow key={e.toolCallId || i} tc={e} />
      })}
    </div>
  )
}
