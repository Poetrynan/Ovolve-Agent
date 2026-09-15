// src/components/settings/MemorySettings.tsx
// The long-term memory editor: create / search / edit / delete the entries the
// agent sees in every single prompt.
//
// This card used to talk to the Electron `memory:*` IPC channels, which wrote
// to `configRoot/memory.json` — a file the agent never opens. So typing here
// felt like teaching the assistant something while actually changing nothing.
// It now goes through `/api/memory/entries` against the LONG_TERM tier, which
// is the always-inject, user-owned tier in the backend's six-tier policy table.
// Same reason the tier is LONG_TERM and not SEMANTIC: a memory a human typed by
// hand should not have to win a retrieval contest to be remembered.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Trash2, Plus, RefreshCw, Brain, Pencil, Check, X, Search, Loader2, FolderOpen,
  ShieldCheck, RotateCcw, History, ChevronDown,
} from 'lucide-react'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@components/ui/dropdown-menu'
import { API_BASE, apiFetch } from '@lib/api'
import { cn } from '@lib/utils'
import { DreamLogPanel } from '@components/settings/DreamLogPanel'
import { MemoryConflictsPanel } from '@components/settings/MemoryConflictsPanel'
import { MemoryTrace } from '@components/settings/MemoryTrace'


/** Mirrors the payload of GET /api/memory/entries.
 *
 *  Exported because the diagnostics panel reads the same endpoint. It used to
 *  keep its own copy of this interface, which is how the two drifted: 0013 added
 *  status/confidence and only one of the two declarations would have learned
 *  about them. One endpoint, one shape. */
export interface MemoryEntry {

  id: string
  content: string
  type: string
  tier: string
  importance: number
  tags: string[]
  hits: number
  createdAt: number
  updatedAt: number
  tokens: number
  editable: boolean
  /** 生命周期。库里写着的状态。 */
  status: string
  /** 召回时真正算出来的结论——把惰性过期也算进去了。和 `status` 一起给是有意的:
   *  一条 `status==='active'` 但 `live===false` 的记忆就是"标着生效中、其实已经
   *  过期"，只显示其中一个，用户就没法知道模型到底看不看得见它。 */
  live: boolean
  confidence: number
  /** 最后一次被确认成立的时间。新鲜度看的是这个而不是创建时间。 */
  lastConfirmedAt: number
  /** 0 表示不过期。 */
  validUntil: number
  /** 为什么变成现在这个状态。 */
  statusReason: string
  supersededBy: string
  source: string
  /** 非空 = 这是一份待批的合并提案：批准后这几条会被归档。 */
  supersedes?: string[]
}


/** 状态筛选的可选值。`''` = 后端的默认集合（活的 + 过期的，不含墓碑）。
 *  墓碑要显式选才出现——但必须选得到，否则误删的记忆就找不回来了。 */
const STATUS_FILTERS = ['', 'active', 'stale', 'candidate', 'archived', 'rejected', 'all'] as const

/** 状态 → 徽章配色。过期（live=false 而 status=active）单独一档，因为它既不是
 *  "生效中"也不是库里记着的任何一个状态。 */
function statusTone(m: MemoryEntry): string {
  if (m.status === 'active' && !m.live) return 'bg-amber-500/10 text-amber-600 border-amber-500/25'
  switch (m.status) {
    case 'active': return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/25'
    case 'stale': return 'bg-amber-500/10 text-amber-600 border-amber-500/25'
    case 'candidate': return 'bg-sky-500/10 text-sky-600 border-sky-500/25'
    case 'rejected': return 'bg-destructive/10 text-destructive border-destructive/25'
    default: return 'bg-muted/60 text-muted-foreground border-border/30'
  }
}

/** 相对时间，只给到"天"这一档——记忆的新鲜度没有精确到分钟的意义。 */
function daysAgo(ts: number): string {
  if (!ts) return ''
  const d = Math.floor((Date.now() / 1000 - ts) / 86400)
  if (d <= 0) return '今天'
  return `${d} 天前`
}


/** One workspace that can hold memories, as returned by /api/memory/roots. */
interface MemoryRoot {
  root: string
  count: number
  displayName: string
  /** false = has memories but is no longer a registered workspace. */
  registered: boolean
  /** true for the `''` bucket — where memories land before a folder is opened. */
  isDefault: boolean
}

/** The always-inject tier. Kept as a constant so the create call and the list
 *  call can never drift onto different tiers — that combination would show an
 *  empty list right after a "successful" save. */
const TIER = 'long-term'

/** Last path segment, for a label that fits. Falls back to the whole string so
 *  a drive root (`D:\`) still renders as something. */
function shortPath(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function MemorySettings() {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [roots, setRoots] = useState<MemoryRoot[]>([])
  // `null` means "not resolved yet"; `''` is a REAL workspace (the default
  // bucket everything lands in before a folder is opened). Conflating the two
  // would lock the panel on a fresh install — no scope to read, nothing addable.
  const [root, setRoot] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // 生命周期筛选。'' 交给后端的默认集合，不在前端复制一份"哪些状态算默认可见"
  // 的规则——两处各写一遍，迟早会有一处漏掉新加的状态。
  const [statusFilter, setStatusFilter] = useState<string>('')
  // 展开了哪一条的来龙去脉。一次只展开一条：追溯有十几行，同时展开几条之后
  // 列表就没法扫了。
  const [traceId, setTraceId] = useState<string | null>(null)


  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  // Distinct from `loading`: "have we ever finished a fetch?". The empty-state
  // line keys off THIS, not off `loading`. Keying it off `loading` made the
  // 「暂无记忆」 line blink out and back on every manual refresh — and since it
  // is a whole text row, the card shrank then grew, which reads as the page
  // flashing. `hasLoaded` stays true across refreshes, so the line holds still.
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  // Workspace list + which one this window has open. Resolved once; switching
  // the picker afterwards only changes local state, it does not switch the
  // app's workspace — reading another project's memory should not yank the
  // user's session into that folder.
  useEffect(() => {
    let cancelled = false
    apiFetch(`${API_BASE}/api/memory/roots`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setRoots(d.roots || [])
        // `??` not `||`: `d.active` is legitimately `''` when no folder is open.
        setRoot((prev) => (prev !== null ? prev : (d.active ?? d.roots?.[0]?.root ?? '')))
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const refresh = useCallback(async (q: string, scope: string | null, st: string) => {
    if (scope === null) return  // not resolved yet; '' is a valid scope
    setLoading(true)
    setError(null)
    try {
      const url = `${API_BASE}/api/memory/entries?tier=${TIER}&limit=200`
        + `&root=${encodeURIComponent(scope)}`
        + (q ? `&q=${encodeURIComponent(q)}` : '')
        + (st ? `&status=${encodeURIComponent(st)}` : '')
      const r = await apiFetch(url)
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      setEntries(d.entries || [])
      setTotal(d.total || 0)
    } catch (e: any) {
      setError(e?.message || String(e))
      setEntries([])
    } finally {
      setLoading(false)
      setHasLoaded(true)
    }
  }, [])

  useEffect(() => { void refresh(query, root, statusFilter) },
    [refresh, query, root, statusFilter])


  const add = async () => {
    const text = draft.trim()
    if (!text || root === null) return
    setBusyId('__new__')
    try {
      const r = await apiFetch(`${API_BASE}/api/memory/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send the picked workspace explicitly: the backend would otherwise
        // stamp the one this window has open, so a memory added while browsing
        // another project would land in the wrong place and vanish from view.
        body: JSON.stringify({ content: text, tier: TIER, root }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      setDraft('')
      await refresh(query, root, statusFilter)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusyId(null)
    }
  }

  const save = async (id: string) => {
    const text = editText.trim()
    if (!text) return
    setBusyId(id)
    try {
      const r = await apiFetch(`${API_BASE}/api/memory/entries/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      setEditingId(null)
      await refresh(query, root, statusFilter)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (id: string) => {
    setBusyId(id)
    try {
      const r = await apiFetch(`${API_BASE}/api/memory/entries/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      await refresh(query, root, statusFilter)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusyId(null)
    }
  }

  /** 生命周期写操作的共用出口。后端会在状态改不动时返回 409 + 原因，这里把原因
   *  原样显示出来——"库拒绝了 rejected → active"比一个静默失败有用得多。 */
  const patchLifecycle = async (id: string, body: Record<string, unknown>) => {
    setBusyId(id)
    try {
      const r = await apiFetch(`${API_BASE}/api/memory/entries/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      await refresh(query, root, statusFilter)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusyId(null)
    }
  }


  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md shadow-xs overflow-hidden divide-y divide-border/30">

        {/* Header: Title + Workspace Picker + Refresh */}
        <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 text-muted-foreground border border-border/40">
                <Brain className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-sm sm:text-base font-bold text-foreground tracking-tight">
                {t('memorySettings.title')}
              </h3>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-muted text-muted-foreground border border-border/40">
                {t('memorySettings.count', { count: total || entries.length })}
              </span>
            </div>
            <p className="text-xs text-muted-foreground/80 leading-relaxed max-w-xl">
              {t('memorySettings.hint')}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Workspace Selector Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-background/85 dark:bg-card/60 border border-border/70 dark:border-white/10 text-xs font-medium text-foreground shadow-2xs hover:bg-background transition-colors cursor-pointer"
                >
                  <FolderOpen size={13} className="shrink-0 text-primary/80" />
                  <span className="truncate max-w-[160px]">
                    {roots.find((w) => w.root === root)?.displayName || (root ? shortPath(root) : t('sidebar.defaultWorkspace'))}
                  </span>
                  <ChevronDown size={12} className="opacity-50 shrink-0 ml-0.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[240px] p-1.5 rounded-xl border border-border/80 bg-popover/95 backdrop-blur-xl shadow-xl">
                {roots.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('memorySettings.noWorkspaces')}</div>
                )}
                {roots.map((w) => {
                  const isCurrent = w.root === root
                  const label = (w.displayName || (w.isDefault ? t('sidebar.defaultWorkspace') : shortPath(w.root)))
                    + (w.count ? ` (${w.count})` : '')
                    + (w.registered ? '' : ' · ' + t('memorySettings.unregistered'))
                  return (
                    <DropdownMenuItem
                      key={w.root}
                      onClick={() => setRoot(w.root)}
                      className={cn(
                        'flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer',
                        isCurrent && 'bg-primary/10 text-primary font-medium',
                      )}
                    >
                      <span className="truncate">{label}</span>
                      {isCurrent && <Check size={13} className="text-primary shrink-0 ml-1.5" />}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              size="sm"
              variant="ghost"
              onClick={() => refresh(query, root, statusFilter)}
              aria-label={t('common.refresh')}
              title={t('common.refresh')}
              className="h-8 w-8 p-0 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/60"
            >
              <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {/* Toolbar: Search + Quick Add Input */}
        <div className="p-4 sm:p-5 space-y-3 bg-muted/10">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
                placeholder={t('memorySettings.addPlaceholderRich')}
                className="h-9 text-xs rounded-xl pr-8 bg-background/90 border-border/50 shadow-2xs"
              />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-mono text-muted-foreground/50 pointer-events-none hidden sm:inline">
                ↵
              </span>
            </div>
            <Button
              size="sm"
              onClick={add}
              disabled={!draft.trim() || root === null || busyId === '__new__'}
              className="h-9 px-4 rounded-xl text-xs font-semibold gap-1.5 shadow-2xs shrink-0"
            >
              {busyId === '__new__' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Plus size={13} />
              )}
              <span>{t('memorySettings.addAction')}</span>
            </Button>
          </div>

          <div className="flex items-center gap-2">
            {(total > 3 || query) && (
              <div className="relative flex-1 min-w-0">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('memorySettings.searchPlaceholder')}
                  className="h-8 pl-8 text-xs rounded-xl bg-background/50 border-border/40"
                />
              </div>
            )}
            {/* 状态筛选 Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="h-8 px-3 rounded-xl bg-background/85 dark:bg-card/60 border border-border/70 dark:border-white/10 text-xs font-medium text-foreground flex items-center gap-1.5 shadow-2xs hover:bg-background transition-colors cursor-pointer shrink-0"
                  title={t('memory.statusFilterTitle')}
                >
                  <span>{t(`memory.statusFilter.${statusFilter || 'default'}`)}</span>
                  <ChevronDown size={12} className="opacity-50 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[140px] p-1 rounded-xl border border-border/80 bg-popover/95 backdrop-blur-xl shadow-xl">
                {STATUS_FILTERS.map((s) => {
                  const isCurrent = s === statusFilter
                  return (
                    <DropdownMenuItem
                      key={s || 'default'}
                      onClick={() => setStatusFilter(s)}
                      className={cn(
                        'flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer',
                        isCurrent && 'bg-primary/10 text-primary font-medium',
                      )}
                    >
                      <span>{t(`memory.statusFilter.${s || 'default'}`)}</span>
                      {isCurrent && <Check size={13} className="text-primary shrink-0 ml-1.5" />}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>


          {error && (
            <div className="px-3 py-2 rounded-xl bg-destructive/10 border border-destructive/20 text-xs text-destructive flex items-center justify-between">
              <span>{t('memory.loadError')}: {error}</span>
              <button onClick={() => setError(null)} className="text-destructive/70 hover:text-destructive text-xs">
                <X size={13} />
              </button>
            </div>
          )}
        </div>

        {/* Entries List or Empty State */}
        <div className="p-4 sm:p-5">
          {entries.length > 0 ? (
            <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
              {entries.map((m) => (
                <div
                  key={m.id}
                  className="group relative rounded-xl border border-border/40 bg-background/60 hover:bg-background/90 hover:border-border/60 transition-all p-3.5 shadow-2xs"
                >
                  {editingId === m.id ? (
                    <div className="space-y-2.5">
                      <textarea
                        autoFocus
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(m.id) }
                          else if (e.key === 'Escape') setEditingId(null)
                        }}
                        rows={3}
                        className="w-full px-3 py-2 rounded-xl bg-background border border-border/60 text-xs leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-ring/40"
                      />
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground/70 font-mono">
                          Ctrl+Enter 保存 · Esc 取消
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingId(null)}
                            className="h-7 px-2.5 text-xs rounded-lg"
                          >
                            取消
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => save(m.id)}
                            disabled={!editText.trim() || busyId === m.id}
                            className="h-7 px-3 text-xs rounded-lg font-semibold"
                          >
                            {busyId === m.id ? <Loader2 size={12} className="animate-spin mr-1" /> : <Check size={12} className="mr-1" />}
                            保存
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0 space-y-2">
                        <p className="text-xs sm:text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap break-words">
                          {m.content}
                        </p>
                        <div className="flex items-center gap-2 flex-wrap text-[10px] text-muted-foreground/70 font-mono">
                          {/* 状态 + 是否真的会被召回。过期的那条 status 还写着
                              active，所以徽章文案单独走一档，否则界面会说"生效中"
                              而模型根本看不见它。 */}
                          <span
                            className={cn('px-1.5 py-0.5 rounded-md border font-medium', statusTone(m))}
                            title={m.statusReason || undefined}
                          >
                            {m.status === 'active' && !m.live
                              ? t('memory.statusExpired')
                              : t(`memory.status.${m.status || 'active'}`)}
                          </span>
                          <span
                            className="px-1.5 py-0.5 rounded-md bg-muted/60 border border-border/30"
                            title={t('memory.confidenceTitle')}
                          >
                            {t('memory.confidenceLabel')} {(m.confidence * 100).toFixed(0)}%
                          </span>
                          {m.lastConfirmedAt > 0 && (
                            <span
                              className="px-1.5 py-0.5 rounded-md bg-muted/60 border border-border/30"
                              title={t('memory.lastConfirmedTitle')}
                            >
                              {t('memory.lastConfirmed')} {daysAgo(m.lastConfirmedAt)}
                            </span>
                          )}
                          <span className="px-1.5 py-0.5 rounded-md bg-muted/60 border border-border/30" title={t('memory.tokenEstimateTitle')}>
                            ≈{m.tokens} {t('memory.tokenUnit')}
                          </span>
                          {m.hits > 0 && (
                            <span className="px-1.5 py-0.5 rounded-md bg-muted/60 border border-border/30 text-foreground/80 font-medium">
                              {t('memory.entryHits', { n: m.hits })}
                            </span>
                          )}
                        </div>

                      </div>

                      <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {/* "这条现在还成立" —— 刷新最后确认时间并给一点置信度。
                            新鲜度看的是最后确认时间，所以这个按钮不是装饰。 */}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => patchLifecycle(m.id, { confirm: true })}
                          disabled={busyId === m.id}
                          className="h-7 w-7 p-0 rounded-lg text-muted-foreground hover:text-emerald-600 hover:bg-emerald-500/10"
                          title={t('memory.entryConfirm')}
                        >
                          <ShieldCheck size={12} />
                        </Button>
                        {/* 「凭什么」——展开这一条的来龙去脉。证据早就记全了，但散在
                            四张互不相通的表里；没有这个入口，用户没有任何办法把它们
                            串起来看。 */}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setTraceId(traceId === m.id ? null : m.id)}
                          className={cn(
                            'h-7 w-7 p-0 rounded-lg hover:bg-muted',
                            traceId === m.id
                              ? 'text-foreground bg-muted'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                          title={t('memoryTrace.open')}
                        >
                          <History size={12} />
                        </Button>
                        {/* 归档的能拿回来，被否决的不能——"这是错的"不该被一次点击
                            改回生效中，那正是库那一层拒绝的转移。 */}
                        {m.status === 'archived' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => patchLifecycle(m.id, { status: 'active', reason: 'user_restored' })}
                            disabled={busyId === m.id}
                            className="h-7 w-7 p-0 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
                            title={t('memory.entryRestore')}
                          >
                            <RotateCcw size={12} />
                          </Button>
                        )}
                        <Button

                          size="sm"
                          variant="ghost"
                          onClick={() => { setEditingId(m.id); setEditText(m.content) }}
                          className="h-7 w-7 p-0 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
                          title={t('memory.entryEdit')}
                        >
                          <Pencil size={12} />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => remove(m.id)}
                          disabled={busyId === m.id}
                          className="h-7 w-7 p-0 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          title={t('memory.entryDelete')}
                        >
                          {busyId === m.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                  {traceId === m.id && editingId !== m.id && <MemoryTrace id={m.id} />}
                </div>
              ))}
            </div>
          ) : hasLoaded ? (
            <div className="py-8 px-4 text-center space-y-2 rounded-xl border border-dashed border-border/40 bg-muted/10">
              <div className="w-9 h-9 mx-auto rounded-xl bg-muted/50 flex items-center justify-center text-muted-foreground">
                <Brain size={18} />
              </div>
              <div className="text-xs font-semibold text-foreground">
                {query ? t('memory.entryNoMatch') : t('memorySettings.emptyTitle')}
              </div>
              <p className="text-[11px] text-muted-foreground max-w-sm mx-auto leading-relaxed">
                {query ? t('memorySettings.noMatchHint') : t('memorySettings.emptyHint')}
              </p>
            </div>
          ) : null}

          {total > entries.length && (
            <p className="text-[10px] text-muted-foreground/70 font-mono mt-3 text-center">
              {t('memory.entryTruncated', { shown: entries.length, total })}
            </p>
          )}
        </div>
      </div>

      <MemoryConflictsPanel
        root={root}
        onChanged={() => void refresh(query, root, statusFilter)}
      />
      <DreamLogPanel root={root} />

    </div>
  )
}
