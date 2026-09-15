import React, { useState } from 'react'
import { Brain, ChevronDown, ChevronUp, Clock, AlertCircle } from 'lucide-react'
import { cn } from '@lib/utils'
import { useTranslation } from 'react-i18next'
import type { MoaCouncil } from '@apptypes/index'

export function MoaCouncilCard({ council }: { council: MoaCouncil }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(council.phase === 'answered')
  const isAsking = council.phase === 'asking'
  const opinions = council.opinions || []
  const okOps = opinions.filter((o) => o.ok)
  const elapsed = typeof council.elapsed_s === 'number' ? council.elapsed_s.toFixed(1) : '?'

  const title = isAsking
    ? t('store.moa.askingTitle', '多模型会诊')
    : okOps.length
      ? t('store.moa.answeredTitle', '会诊完成')
      : t('store.moa.failedTitle', '会诊失败')

  return (
    <div className="flex flex-col items-center my-2.5 px-4 select-none">
      <div
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'group inline-flex max-w-[92%] items-center gap-2 rounded-full border px-3.5 py-1.5',
          'text-xs bg-background/85 backdrop-blur-sm cursor-pointer shadow-xs transition-all',
          isAsking
            ? 'border-violet-500/30 text-violet-600 dark:text-violet-400'
            : okOps.length
              ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
              : 'border-destructive/30 text-destructive'
        )}
      >
        <Brain className={cn('h-3.5 w-3.5 shrink-0', isAsking && 'animate-pulse')} />
        <span className="font-semibold text-[11px]">{title}</span>
        <span className="truncate max-w-[14rem] text-[11px] opacity-75">
          {isAsking
            ? (council.advisors || []).map((a) => a.model).filter(Boolean).join(', ')
            : okOps.length
              ? t('store.moa.elapsed', '{{elapsed}}s · {{count}} advisors', { elapsed, count: okOps.length })
              : t('store.moa.allFailed', '会诊 advisors 均未响应')}
        </span>
        {expanded ? (
          <ChevronUp className="h-3 w-3 shrink-0 opacity-60" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        )}
      </div>

      {expanded && (
        <div className="mt-2 w-full max-w-lg p-3.5 rounded-xl border border-border/70 bg-card/95 backdrop-blur-md shadow-md text-xs space-y-2.5 animate-in fade-in slide-in-from-top-1 duration-150">
          {isAsking && (
            <p className="text-muted-foreground text-[11px]">
              {t('store.moa.asking', '征询 {{names}} 的独立观点…', {
                names: (council.advisors || []).map((a) => a.model).filter(Boolean).join(', '),
              })}
            </p>
          )}
          {!isAsking && opinions.map((op, i) => (
            <div
              key={`${op.model}-${i}`}
              className={cn(
                'rounded-lg border p-2.5',
                op.ok ? 'border-border/50 bg-muted/20' : 'border-destructive/20 bg-destructive/5'
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[10px] font-semibold text-foreground/90">{op.model}</span>
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  {op.ok ? <Clock className="w-3 h-3" /> : <AlertCircle className="w-3 h-3 text-destructive" />}
                  {typeof op.elapsed_s === 'number' ? `${op.elapsed_s}s` : ''}
                </span>
              </div>
              {op.ok && op.text ? (
                <p className="text-[11px] leading-relaxed text-foreground/85 whitespace-pre-wrap">{op.text}</p>
              ) : (
                <p className="text-[10px] text-destructive">{op.error || t('store.moa.noResponse', '无响应')}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
