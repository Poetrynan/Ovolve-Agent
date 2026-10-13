// src/components/chat/ContextMeter.tsx
// Context-window usage meter with a breakdown popover.
//
// Named for what it *is*, not for the Radix part it happens to begin with. As
// `ContextUsageTrigger` the name described only the collapsed pill and left the
// popover — the substance — unnamed. "Meter" is also the accessible semantic:
// a value inside a known range that may fall as well as rise (folding the
// history lowers it). A `progressbar` would be wrong, because it asserts a task
// advancing toward completion, so "60% used" gets announced as "60% complete".

import { useEffect } from 'react'
import { BarChart3, FoldVertical, Loader2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@components/ui/popover'
import { useContextUsageStore } from '@store/contextUsageStore'
import { useAgentStore } from '@store/agentStore'
import { fetchJson, API_BASE } from '@lib/api'
import { cn } from '@lib/utils'

function severityFor(percent: number | null): { text: string; bar: string } {
  if (percent === null) return { text: 'text-muted-foreground', bar: 'bg-muted-foreground/50' }
  if (percent < 60) return { text: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500' }
  if (percent < 80) return { text: 'text-amber-500', bar: 'bg-amber-500' }
  return { text: 'text-rose-500', bar: 'bg-rose-500' }
}

/** Compact token count — k/M units ONLY, never raw hundreds. Sub-1k values
 * ceil to the next tenth of a k so a real value can't collapse to "0.0k". */
function fmt(n: number | undefined | null): string {
  if (!n || n <= 0) return '0k'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return `${(Math.ceil(n / 100) / 10).toFixed(1)}k`
}

export function ContextMeter() {
  const { usage, cache, actions, applyAnalytics } = useContextUsageStore()
  const isFolding = useAgentStore((s) => s.isFolding)
  const foldContext = useAgentStore((s) => s.foldContext)
  const sessionId = useAgentStore((s) => s.sessionId)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const fetchAnalytics = async () => {
      try {
        // session_id so the backend resolves THIS window's router — the
        // primary one would describe another window's prompt state.
        const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
        const snap = await fetchJson<any>(`${API_BASE}/api/token-analytics${qs}`)
        if (snap && snap.breakdown) applyAnalytics(snap)
      } catch {
        /* backend not ready yet */
      }
    }
    timer = setTimeout(fetchAnalytics, 200)
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [applyAnalytics, sessionId])

  const msgTokens = usage.userTokens + usage.assistantTokens + usage.toolResultTokens + usage.reasoningTokens
  const hasMessages = msgTokens > 0
  const segments = [
    {
      label: '对话消息',
      value: msgTokens,
      color: 'bg-foreground',
      dot: 'bg-foreground',
    },
    {
      label: '系统提示词',
      value: usage.systemPromptTokens,
      color: 'bg-emerald-500',
      dot: 'bg-emerald-500',
    },
    {
      label: '工具定义',
      value: usage.toolDefTokens,
      color: 'bg-amber-500',
      dot: 'bg-amber-500',
    },
    {
      label: '技能配置',
      value: usage.skillTokens,
      color: 'bg-purple-500',
      dot: 'bg-purple-500',
    },
  ]
  const totalConstituents = segments.reduce((s, p) => s + p.value, 0)
  // The system prompt + tool schemas + skills are real window occupancy even
  // before the first message — hiding them made a fresh session read "0k"
  // while the backend reported five figures of overhead. `currentTokens`
  // already includes the draft via setPendingInput; the fallback chain covers
  // the pre-fetch moment (breakdown known but no totals yet) and typing with
  // nothing else loaded.
  const currentTokens = usage.currentTokens || totalConstituents || usage.pendingInputTokens || 0

  const percent = usage.windowKnown && usage.maxTokens > 0
    ? Math.min((currentTokens / usage.maxTokens) * 100, 100)
    : null
  const sev = severityFor(percent)

  const hasCacheActivity = (cache.cacheReadTokens > 0 || cache.cacheCreationTokens > 0) && hasMessages
  const hitRatePct = Math.round((cache.averageHitRate || 0) * 100)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          data-testid="ovolve-context-usage-trigger"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-xl text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-all select-none border border-transparent hover:border-border/30"
        >
          <BarChart3 size={12} className={sev.text} />
          <span className="font-mono font-bold text-xs text-foreground">
            {fmt(currentTokens)}
          </span>
          <span className="opacity-40 text-[11px]">/</span>
          <span className="font-mono text-xs text-muted-foreground">
            {usage.windowKnown ? fmt(usage.maxTokens) : '—'}
          </span>
          <span
            role={percent !== null ? 'meter' : undefined}
            aria-valuemin={percent !== null ? 0 : undefined}
            aria-valuemax={percent !== null ? 100 : undefined}
            aria-valuenow={percent !== null ? Math.round(percent) : undefined}
            aria-valuetext={
              percent !== null
                ? `${fmt(currentTokens)} / ${fmt(usage.maxTokens)}（${percent.toFixed(0)}%）`
                : undefined
            }
            aria-label={percent !== null ? '上下文占用' : undefined}
            className="relative w-7 h-1 rounded-full bg-muted/80 overflow-hidden ml-0.5"
          >
            {percent !== null && (
              <span
                className={cn('absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out', sev.bar)}
                style={{ width: `${percent}%` }}
              />
            )}
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        collisionPadding={12}
        className="w-[240px] p-3.5 space-y-2.5 shadow-2xl border-border/60 bg-popover/90 backdrop-blur-2xl rounded-2xl z-50 select-none"
      >
        {/* Header: Title + Token usage + Compress Button */}
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-baseline gap-1 font-mono">
            <span className="text-xs font-bold text-foreground tracking-tight">
              {fmt(currentTokens)}
            </span>
            <span className="text-[10.5px] text-muted-foreground">
              / {usage.windowKnown ? fmt(usage.maxTokens) : '—'}
            </span>
            {percent !== null && (
              <span className={cn('text-[10px] font-semibold ml-0.5', sev.text)}>
                ({percent.toFixed(0)}%)
              </span>
            )}
          </div>

          <button
            onClick={() => foldContext()}
            disabled={isFolding}
            title={isFolding ? "正在折叠压缩上下文..." : "将历史长对话智能折叠压缩 (/fold)"}
            className={cn(
              "inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[10px] font-medium border transition-colors",
              isFolding
                ? "bg-primary/10 text-primary border-primary/30 cursor-not-allowed"
                : "text-muted-foreground hover:text-foreground bg-muted/60 hover:bg-muted border border-border/40"
            )}
          >
            {isFolding ? <Loader2 size={10} className="animate-spin" /> : <FoldVertical size={10} />}
            <span>{isFolding ? '压缩中...' : '压缩'}</span>
          </button>
        </div>

        {/* Composition of what is in the window. `aria-hidden` because the four
            rows underneath state the same numbers in words — a screen reader
            reading the bar too would announce the breakdown twice. */}
        <div aria-hidden className="h-1.5 w-full rounded-full overflow-hidden bg-muted/60 flex gap-0.5">
          {hasMessages ? (
            segments.map((p) => {
              if (p.value <= 0) return null
              const pct = (p.value / (totalConstituents || 1)) * 100
              return (
                <div
                  key={p.label}
                  style={{ width: `${Math.max(4, pct)}%` }}
                  className={cn('h-full rounded-full transition-all duration-300', p.color)}
                  title={`${p.label}: ${fmt(p.value)} (${pct.toFixed(1)}%)`}
                />
              )
            })
          ) : (
            <div
              style={{ width: `${Math.max(0, percent ?? 0)}%` }}
              className="h-full rounded-full bg-foreground transition-all duration-300"
            />
          )}
        </div>

        {/* Compact 4-Row Breakdown */}
        <div className="space-y-1 pt-0.5 text-[11px]">
          {segments.map((p) => (
            <div key={p.label} className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', p.dot)} />
                <span className="text-muted-foreground truncate">{p.label}</span>
              </div>
              <span className="font-mono text-foreground/90 font-medium ml-2">
                {fmt(p.value)}
              </span>
            </div>
          ))}
        </div>

        {/* Concise Footer Status */}
        <div className="flex items-center justify-between text-[10px] pt-1.5 border-t border-border/30 text-muted-foreground">
          {hasCacheActivity ? (
            <>
              <span className="text-emerald-500 font-medium">缓存命中 {hitRatePct}%</span>
              <span className="text-muted-foreground/70">极速响应</span>
            </>
          ) : hasMessages ? (
            <>
              <span title="模型服务商在多轮对话复用上下文时自动触发缓存">未命中缓存 (0%)</span>
              <span className="text-muted-foreground/60 text-[9.5px]">单轮/渠道未开启</span>
            </>
          ) : (
            <>
              <span title="首轮对话将写入系统提示词与工具定义，后续多轮对话将自动复用并享受缓存加速">
                Prompt 缓存已就绪
              </span>
              <span className="text-muted-foreground/60 text-[9.5px]">等待多轮复用</span>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
