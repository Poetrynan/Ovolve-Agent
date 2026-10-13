// src/components/chat/ReflexionCard.tsx
// Glassmorphic Reflexion Card & Capsule (NeurIPS 2023 verbal self-reflection)
import { useState } from 'react'
import { Sparkles, ShieldCheck, ChevronDown, ChevronUp, AlertCircle, Lightbulb, CheckCircle2, Bookmark } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ReflexionItem {
  id?: string
  scenario?: string
  root_cause?: string
  alternative_strategy?: string
  prevention_rule?: string
  source_tool?: string
  confidence?: number
  tags?: string[]
}

interface ReflexionCardProps {
  reflection: ReflexionItem
  compact?: boolean
  className?: string
}

export function ReflexionCard({ reflection, compact = false, className }: ReflexionCardProps) {
  const [expanded, setExpanded] = useState(!compact)

  const toolName = reflection.source_tool || 'Action'
  const rootCause = reflection.root_cause || '执行遇到阻碍或参数不匹配'
  const altStrategy = reflection.alternative_strategy || '调整入参并进行前置状态校验'
  const prevRule = reflection.prevention_rule || '在调用工具前执行前置检查并记录经验'

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border transition-all duration-300',
        'border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10 backdrop-blur-xl',
        'shadow-sm dark:shadow-amber-500/5 text-xs text-foreground',
        className,
      )}
    >
      {/* Top Capsule Header */}
      <div
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between gap-2 px-3.5 py-2.5 cursor-pointer hover:bg-amber-500/10 transition-colors select-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 font-bold">
            <Lightbulb size={12} className="animate-pulse" />
          </div>
          <span className="font-semibold text-amber-700 dark:text-amber-300 text-[11px] tracking-wide uppercase">
            Reflexion 避坑反思
          </span>
          {reflection.source_tool && (
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/20 truncate">
              {toolName}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-600/80 dark:text-amber-400/80 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
            <Bookmark size={9} />
            已存入情景记忆
          </span>
          {expanded ? <ChevronUp size={13} className="text-muted-foreground" /> : <ChevronDown size={13} className="text-muted-foreground" />}
        </div>
      </div>

      {/* Expanded Content Body */}
      {expanded && (
        <div className="px-3.5 pb-3 pt-1 border-t border-amber-500/20 space-y-2.5 text-[11px] animate-fade-in">
          {/* Root Cause */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-200">
              <AlertCircle size={12} className="text-amber-500 shrink-0" />
              <span>根因诊断 (Root Cause):</span>
            </div>
            <p className="pl-4 text-muted-foreground leading-relaxed">
              {rootCause}
            </p>
          </div>

          {/* Alternative Strategy */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-200">
              <Sparkles size={12} className="text-amber-500 shrink-0" />
              <span>替代与自愈策略 (Alternative Strategy):</span>
            </div>
            <p className="pl-4 text-muted-foreground leading-relaxed">
              {altStrategy}
            </p>
          </div>

          {/* Prevention Rule */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
              <ShieldCheck size={12} className="text-emerald-500 shrink-0" />
              <span>前置防范规则 (Prevention Rule):</span>
            </div>
            <div className="ml-4 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-800 dark:text-emerald-200 text-[10.5px]">
              {prevRule}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
