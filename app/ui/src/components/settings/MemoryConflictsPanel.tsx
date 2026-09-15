// src/components/settings/MemoryConflictsPanel.tsx
// 需要人裁决的分歧 + 内容重复的活记忆，一个面板两件事。
//
// 存在的理由：写入闸门已经会在落盘前发现"这条和那条互相矛盾"，把新的那条压成
// candidate 等裁决——但在这个面板出现之前，用户根本看不到有东西在等他。一个只有
// 后端知道的待办等于没有待办：candidate 永远不进召回，那条记忆就这么烂在库里。
//
// 裁决动作刻意只有两个方向，且都不是硬删除：留这条（→ active）/ 不要这条
// （→ archived，还能从设置页找回来）。
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronDown, Copy, Check, Archive, Loader2, RefreshCw, Moon } from 'lucide-react'

import { Button } from '@components/ui/button'
import { API_BASE, apiFetch } from '@lib/api'
import { cn } from '@lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@components/ui/collapsible'
import type { MemoryEntry } from '@components/settings/MemorySettings'

interface ConflictGroup {
  claim: MemoryEntry
  peers: MemoryEntry[]
}

interface MergeGroup {
  proposal: MemoryEntry
  sources: MemoryEntry[]
}

interface ConflictsResponse {
  root: string
  conflicts: ConflictGroup[]
  duplicates: MemoryEntry[][]
  pendingMerges: MergeGroup[]
  error?: string
}


export function MemoryConflictsPanel({ root, onChanged }: {
  root: string | null
  /** 裁决之后通知父面板刷新列表：同一条记忆在两处显示，状态必须同时变。 */
  onChanged?: () => void
}) {
  const { t } = useTranslation()
  const [conflicts, setConflicts] = useState<ConflictGroup[]>([])
  const [duplicates, setDuplicates] = useState<MemoryEntry[][]>([])
  const [merges, setMerges] = useState<MergeGroup[]>([])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async (scope: string | null) => {
    if (scope === null) return
    setLoading(true)
    setError(null)
    try {
      const r = await apiFetch(
        `${API_BASE}/api/memory/conflicts?limit=50&root=${encodeURIComponent(scope)}`)
      const d: ConflictsResponse = await r.json()
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      setConflicts(d.conflicts || [])
      setDuplicates(d.duplicates || [])
      setMerges(d.pendingMerges || [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setConflicts([])
      setDuplicates([])
      setMerges([])
    } finally {

      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh(root) }, [refresh, root])

  /** 裁决。后端会在状态改不动时返回 409 + 原因，原样显示出来。 */
  const decide = async (id: string, status: string) => {
    setBusyId(id)
    try {
      const r = await apiFetch(`${API_BASE}/api/memory/entries/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reason: 'user_adjudicated' }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      await refresh(root)
      onChanged?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  /** 裁决一份合并提案。和 decide 分开走，因为批准会连带归档别的行——后端也是
   *  分开的字段，前端不该把两个不同副作用的动作合成一个。 */
  const decideMerge = async (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id)
    try {
      const r = await apiFetch(`${API_BASE}/api/memory/entries/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergeDecision: decision }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      await refresh(root)
      onChanged?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const pending = conflicts.length + duplicates.length + merges.length


  // 没有待裁决的东西时整块不渲染：一个永久显示"0 条冲突"的面板只是噪声。
  if (pending === 0 && !error) return null

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn(
        'rounded-2xl border overflow-hidden',
        conflicts.length > 0
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-border/50 bg-card/55',
      )}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20"
          >
            <div className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border',
              conflicts.length > 0
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'border-border/40 bg-muted/50 text-muted-foreground',
            )}>
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {t('memoryConflicts.title')}
                </span>
                <span className="rounded-full border border-border/40 bg-background/70 px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                  {pending}
                </span>
              </div>
              <p className="truncate text-[11px] text-muted-foreground">
                {error || t('memoryConflicts.summary', {
                  conflicts: conflicts.length, duplicates: duplicates.length,
                  merges: merges.length,
                })}

              </p>
            </div>
            <ChevronDown className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              open && 'rotate-180')} />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t border-border/40 px-4 pb-4 pt-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <p className="max-w-xl text-xs leading-relaxed text-muted-foreground/85">
                {t('memoryConflicts.desc')}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 shrink-0 rounded-xl p-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                onClick={() => void refresh(root)}
                aria-label={t('common.refresh')}
              >
                <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
              </Button>
            </div>
            {error && <p className="mb-3 text-xs text-destructive">{error}</p>}

            <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
              {merges.map((m) => (
                <MergeCard
                  key={m.proposal.id}
                  group={m}
                  busyId={busyId}
                  onDecide={decideMerge}
                />
              ))}
              {conflicts.map((g) => (

                <ConflictCard
                  key={g.claim.id}
                  group={g}
                  busyId={busyId}
                  onDecide={decide}
                />
              ))}
              {duplicates.map((grp) => (
                <DuplicateCard
                  key={grp.map((i) => i.id).join('|')}
                  group={grp}
                  busyId={busyId}
                  onDecide={decide}
                />
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

/** 一组互相矛盾的记忆。两边并列显示，因为哪边是"新的"并不代表哪边是对的。 */
function ConflictCard({ group, busyId, onDecide }: {
  group: ConflictGroup
  busyId: string | null
  onDecide: (id: string, status: string) => void
}) {
  const { t } = useTranslation()
  const rows = [group.claim, ...group.peers]
  return (
    <div className="rounded-xl border border-amber-500/30 bg-background/60 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
        <AlertTriangle size={11} />
        {t('memoryConflicts.contradicts')}
      </div>
      {rows.map((m) => (
        <MemoryRow key={m.id} m={m} busyId={busyId} onDecide={onDecide} />
      ))}
      <p className="text-[10px] leading-relaxed text-muted-foreground/70">
        {t('memoryConflicts.contradictsHint')}
      </p>
    </div>
  )
}

/** 一份 Dream 提的合并。批准前上下两半都原样活着，所以两半都要看得见：
 *  上面是它想写下的那条，下面是批准后会被归档的那几条。 */
function MergeCard({ group, busyId, onDecide }: {
  group: MergeGroup
  busyId: string | null
  onDecide: (id: string, decision: 'approve' | 'reject') => void
}) {
  const { t } = useTranslation()
  const busy = busyId === group.proposal.id
  return (
    <div className="rounded-xl border border-indigo-500/30 bg-background/60 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-500 dark:text-indigo-400">
        <Moon size={11} />
        {t('memoryConflicts.mergeProposal')}
      </div>
      <p className="text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
        {group.proposal.content}
      </p>
      <div className="rounded-lg border border-border/30 bg-muted/10 p-2 space-y-1">
        <div className="text-[10px] font-medium text-muted-foreground">
          {t('memoryConflicts.mergeReplaces', { count: group.sources.length })}
        </div>
        {group.sources.map((s) => (
          <p key={s.id} className="text-[11px] leading-relaxed text-muted-foreground/85 whitespace-pre-wrap break-words">
            · {s.content}
          </p>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onDecide(group.proposal.id, 'reject')}
          className="h-7 rounded-lg px-2 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10"
        >
          {t('memoryConflicts.mergeReject')}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onDecide(group.proposal.id, 'approve')}
          className="h-7 rounded-lg px-3 text-[11px] font-semibold gap-1.5"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          {t('memoryConflicts.mergeApprove')}
        </Button>
      </div>
    </div>
  )
}

/** 一组内容等价的记忆。留一条就够，其余归档。 */

function DuplicateCard({ group, busyId, onDecide }: {
  group: MemoryEntry[]
  busyId: string | null
  onDecide: (id: string, status: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded-xl border border-border/40 bg-background/50 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Copy size={11} />
        {t('memoryConflicts.duplicate', { count: group.length })}
      </div>
      {group.map((m) => (
        <MemoryRow key={m.id} m={m} busyId={busyId} onDecide={onDecide} />
      ))}
    </div>
  )
}

/** 一条记忆 + 两个裁决按钮。状态和置信度一起显示，因为"留哪条"要靠这两个数字判断。 */
function MemoryRow({ m, busyId, onDecide }: {
  m: MemoryEntry
  busyId: string | null
  onDecide: (id: string, status: string) => void
}) {
  const { t } = useTranslation()
  const busy = busyId === m.id
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/30 bg-muted/10 p-2">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
          {m.content}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-muted-foreground/70">
          <span className="rounded border border-border/40 px-1 py-0.5">
            {t(`memory.status.${m.status || 'active'}`, m.status || 'active')}
          </span>
          {typeof m.confidence === 'number' && (
            <span>{Math.round(m.confidence * 100)}%</span>
          )}
          {m.source && <span className="truncate max-w-[8rem]">{m.source}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || m.status === 'active'}
          onClick={() => onDecide(m.id, 'active')}
          title={t('memoryConflicts.keep')}
          aria-label={t('memoryConflicts.keep')}
          className="h-7 w-7 p-0 rounded-lg text-muted-foreground hover:text-emerald-600 hover:bg-emerald-500/10"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onDecide(m.id, 'archived')}
          title={t('memoryConflicts.discard')}
          aria-label={t('memoryConflicts.discard')}
          className="h-7 w-7 p-0 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"
        >
          <Archive size={12} />
        </Button>
      </div>
    </div>
  )
}
