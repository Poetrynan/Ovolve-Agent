// src/components/settings/MemoryTrace.tsx
// 一条长期知识的来龙去脉。
//
// # 为什么需要它
//
// 到这一步，"这条记忆凭什么在这儿"的证据全都记下来了：谁写的、依据哪个目标和哪些
// 事件、是哪一趟整合任务提议的、那一趟的演化观察怎么判的、它取代了谁、又被谁取代、
// 有没有结构化镜像。但这些散在 memory_entries / dream_runs / observations /
// wiki_claims 四张互不相通的表里——散落的证据等于没有证据，用户没有任何办法把它们
// 串起来看。
//
// 所以这里只做一件事：点开一条，按时间把它的一生列出来。
//
// # 为什么按需拉取
//
// 追溯要跨四张表，而列表里可能有几百条。默认全拉会让打开设置页变慢，而绝大多数时候
// 用户只想看其中一条。点开才拉，关掉不缓存——追溯本来就该反映**现在**的状态，
// 缓存一份旧的会让人看到已经不成立的关系。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { API_BASE, apiFetch } from '@lib/api'

interface TraceEvent {
  ts: number
  dated: boolean
  kind: string
  text: string
  ref?: string
}

/** 事件类型 → 颜色。看一眼就能分出"来源"、"冲突"和"已被取代"。 */
function tone(kind: string): string {
  switch (kind) {
    case 'conflict': return 'text-amber-600 dark:text-amber-500'
    case 'superseded': return 'text-muted-foreground/60 line-through'
    case 'proposal': return 'text-sky-600 dark:text-sky-400'
    case 'observation': return 'text-violet-600 dark:text-violet-400'
    case 'dream': return 'text-indigo-600 dark:text-indigo-400'
    default: return 'text-foreground/75'
  }
}

function stamp(ts: number): string {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleString()
}

export function MemoryTrace({ id }: { id: string }) {
  const { t } = useTranslation()
  const [events, setEvents] = useState<TraceEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setEvents(null)
    setError(null)
    void (async () => {
      try {
        const r = await apiFetch(
          `${API_BASE}/api/memory/entries/${encodeURIComponent(id)}/trace`)
        if (!r.ok) throw new Error(String(r.status))
        const d = await r.json()
        if (alive) setEvents((d?.events as TraceEvent[]) || [])
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { alive = false }
  }, [id])

  if (error) {
    return (
      <p className="text-[10px] text-destructive/80 px-1 py-1.5">
        {t('memoryTrace.failed')}: {error}
      </p>
    )
  }
  if (events === null) {
    return (
      <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70 px-1 py-1.5">
        <Loader2 size={11} className="animate-spin" />
        {t('memoryTrace.loading')}
      </p>
    )
  }
  if (events.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground/70 px-1 py-1.5">
        {t('memoryTrace.empty')}
      </p>
    )
  }

  // 有时间的走时间轴，没时间的（当前状态、指向关系）单独一组。混在一起会让人以为
  // "与 X 矛盾"是某个时刻发生的事件，其实它是此刻的状态。
  const dated = events.filter((e) => e.dated)
  const facts = events.filter((e) => !e.dated)

  return (
    <div className="mt-2.5 pt-2.5 border-t border-border/30 space-y-2">
      {dated.length > 0 && (
        <ol className="space-y-1">
          {dated.map((e, i) => (
            <li key={`${e.kind}-${e.ts}-${i}`} className="flex gap-2 text-[10px] leading-relaxed">
              <span className="shrink-0 font-mono text-muted-foreground/55 w-[112px]">
                {stamp(e.ts)}
              </span>
              <span className={tone(e.kind)}>{e.text}</span>
            </li>
          ))}
        </ol>
      )}
      {facts.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground/60">
            {t('memoryTrace.currentState')}
          </p>
          <ul className="space-y-0.5">
            {facts.map((e, i) => (
              <li key={`${e.kind}-${i}`} className={`text-[10px] leading-relaxed ${tone(e.kind)}`}>
                · {e.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
