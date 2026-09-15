import React from 'react'
import { Clock, Zap, X, CornerDownRight } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'

export const QueuedPromptBar: React.FC = () => {
  const queuedPrompts = useAgentStore((s) => s.queuedPrompts)
  const removeQueuedPrompt = useAgentStore((s) => s.removeQueuedPrompt)
  const steerImmediate = useAgentStore((s) => s.steerImmediate)

  if (queuedPrompts.length === 0) return null

  return (
    <div className="w-full space-y-1.5 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
      {queuedPrompts.map((item, index) => (
        <div
          key={item.id}
          className="flex items-center justify-between px-3 py-2 rounded-xl bg-card/90 dark:bg-card/70 backdrop-blur-xl border border-sky-500/30 dark:border-sky-400/25 shadow-lg shadow-sky-500/5 text-xs text-foreground/90 transition-all hover:border-sky-500/50"
        >
          {/* Left: Queue index & text preview */}
          <div className="flex items-center gap-2 truncate pr-2">
            <div className="flex items-center gap-1 text-[11px] font-mono font-medium text-sky-400 shrink-0">
              <Clock className="w-3 h-3 animate-pulse" />
              <span>排队 #{index + 1}</span>
            </div>
            <CornerDownRight className="w-3 h-3 text-muted-foreground/60 shrink-0" />
            <span className="truncate text-[11.5px] text-foreground/80 font-sans">
              {item.content}
            </span>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Steer Button */}
            <button
              onClick={() => steerImmediate(item.id)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/30 text-[11px] font-medium transition-all active:scale-95 shadow-sm"
              title="立即打断当前执行，并优先执行此排队指令 (Steer/Interrupt)"
            >
              <Zap className="w-3 h-3 text-sky-400 fill-sky-400" />
              <span>立即插队</span>
            </button>

            {/* Cancel Button */}
            <button
              onClick={() => removeQueuedPrompt(item.id)}
              className="p-1 rounded-lg hover:bg-white/10 text-muted-foreground/70 hover:text-foreground transition-colors"
              title="取消此排队指令"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
