import React, { useState } from 'react'
import { Activity, Info, Sparkles } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { useAgentStore } from '../../store/agentStore'

interface ContextMeterProps {
  usedTokens?: number
  maxContextTokens?: number
}

export const ContextMeter: React.FC<ContextMeterProps> = ({
  usedTokens = 4250,
  maxContextTokens = 128000,
}) => {
  const [open, setOpen] = useState(false)
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)

  // Calculate actual tokens from session messages
  const messageCount = activeSession?.messages.length || 0
  const estimatedMessageTokens = activeSession?.messages.reduce((acc, m) => {
    return acc + (m.tokens?.total || Math.ceil((m.content.length + (m.reasoning?.length || 0)) / 3.5))
  }, 0) || 0

  const totalTokens = Math.max(usedTokens, estimatedMessageTokens + 2100)
  const ratio = Math.min(1, totalTokens / maxContextTokens)
  const percentage = Math.round(ratio * 100)

  // Severity color
  const statusColor =
    ratio > 0.85
      ? 'text-rose-500 bg-rose-500/15 border-rose-500/30'
      : ratio > 0.6
        ? 'text-amber-500 bg-amber-500/15 border-amber-500/30'
        : 'text-emerald-500 bg-emerald-500/15 border-emerald-500/30'

  const progressColor =
    ratio > 0.85
      ? 'bg-rose-500'
      : ratio > 0.6
        ? 'bg-amber-500'
        : 'bg-emerald-500'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-mono border border-border/80 dark:border-white/10 bg-muted/40 dark:bg-white/[0.04] hover:bg-muted/80 hover:border-border transition-all cursor-pointer select-none"
          title="Context Token Usage Meter"
        >
          <Activity size={11} className={statusColor.split(' ')[0]} />
          <span className="font-semibold text-foreground/90">{totalTokens.toLocaleString()}</span>
          <span className="text-muted-foreground">/</span>
          <span className="text-muted-foreground font-normal">{(maxContextTokens / 1000).toFixed(0)}k</span>
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-4 space-y-3" align="end" side="top">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-medium text-xs text-foreground">
            <Sparkles size={14} className="text-primary" />
            <span>Context Window Allocation</span>
          </div>
          <span className={`text-[10px] px-1.5 py-0.2 rounded-md font-mono font-bold border ${statusColor}`}>
            {percentage}%
          </span>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-2 rounded-full bg-muted dark:bg-white/10 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${progressColor}`}
            style={{ width: `${Math.max(2, percentage)}%` }}
          />
        </div>

        {/* Breakdown details */}
        <div className="space-y-1.5 text-[11px] font-mono">
          <div className="flex justify-between text-muted-foreground">
            <span>System Prompt & Tools:</span>
            <span className="text-foreground">~1,800 tokens</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Pre-compaction Threshold:</span>
            <span className="text-foreground">4,000 tokens</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Session Messages ({messageCount}):</span>
            <span className="text-foreground">{estimatedMessageTokens.toLocaleString()} tokens</span>
          </div>
          <div className="flex justify-between text-muted-foreground border-t border-border/60 dark:border-white/10 pt-1">
            <span>Free Context Remaining:</span>
            <span className="text-emerald-500 font-semibold">
              {(maxContextTokens - totalTokens).toLocaleString()} tokens
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default ContextMeter
