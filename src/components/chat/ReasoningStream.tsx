import React, { useState } from 'react'
import { Brain, ChevronDown, ChevronRight, Clock } from 'lucide-react'

interface ReasoningStreamProps {
  reasoning: string
  duration?: number
  isLive?: boolean
}

export const ReasoningStream: React.FC<ReasoningStreamProps> = ({ reasoning, duration, isLive }) => {
  const [isOpen, setIsOpen] = useState(isLive || false)

  if (!reasoning && !isLive) return null

  return (
    <div className="my-2 rounded-xl bg-indigo-950/20 border border-indigo-500/20 overflow-hidden text-xs transition-all">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3 py-2 flex items-center justify-between bg-indigo-900/20 hover:bg-indigo-900/30 text-indigo-300 select-none transition-colors"
      >
        <div className="flex items-center gap-2">
          <Brain className={`w-3.5 h-3.5 ${isLive ? 'animate-pulse text-indigo-400' : 'text-indigo-400/80'}`} />
          <span className="font-medium">
            {isLive ? 'Ovolve Reasoning in progress...' : 'Thought Process'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-indigo-400/70">
          {duration ? (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {duration.toFixed(1)}s
            </span>
          ) : null}
          {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </div>
      </button>

      {isOpen && (
        <div className="p-3 bg-black/20 text-indigo-200/90 font-mono text-[11px] leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto border-t border-indigo-500/10">
          {reasoning || 'Analyzing goal parameters, constraints, and selecting optimal tools...'}
        </div>
      )}
    </div>
  )
}
