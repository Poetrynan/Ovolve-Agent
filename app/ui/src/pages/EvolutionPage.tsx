/**
 * EvolutionPage — AI 习惯与自进化中心（统一入口）。
 *
 * 融合「待确认审批」与「自进化看板与知识库」：
 * 1. 待确认建议 (Inbox)：集中裁决 AI 提炼的新习惯与新技能候选。
 * 2. 已生效习惯库 (Library)：管理已写入 AGENTS.md / MEMORY.md 的长期规则与效果反馈。
 * 3. 自进化配置与复盘 (Settings & Ledger)：配置自进化灵敏度档位与查看底层任务巡检记录。
 * 严格无 Emoji 设计。
 */
import { useEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Sparkles, AlertCircle, X, Check, Ban, RefreshCw, FileText,
  Repeat, ChevronDown, ShieldCheck, ShieldAlert, Pencil, RotateCcw,
  CheckCircle2, Dna, CheckCheck, Inbox, BookOpen, Sliders, Search,
  FolderTree, UserCheck, Globe, Wifi, XCircle, ArrowRight
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { readGate } from '@/lib/gateReport'
import { Badge } from '@components/ui/badge'
import { Button } from '@components/ui/button'
import { Card, CardContent } from '@components/ui/card'
import { SegmentedControl, type Segment } from '@components/ui/SegmentedControl'
import { HabitProposalCard } from '@components/evolution/HabitProposalCard'
import { useEvolutionStore, type EvolutionMode, type Proposal } from '@store/evolutionStore'
import { useApprovalsStore, type ApprovalSkillCandidate } from '@store/approvalsStore'
import { useSkillStore } from '@store/skillStore'
import { relativeTime, useSessionListStore } from '@store/sessionListStore'
import { API_BASE, apiFetch, fetchJson } from '@lib/api'

interface Notice { tone: 'ok' | 'warn' | 'muted'; text: string }

type PageTab = 'pending' | 'library' | 'settings'

export default function EvolutionPage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<PageTab>('pending')
  const [searchQuery, setSearchQuery] = useState('')
  const [scopeFilter, setScopeFilter] = useState<'all' | 'AGENTS.md' | 'MEMORY.md'>('all')

  const {
    mode, policy, pending, history, counts, loading, loaded, refreshing, mining,
    errors, busyIds, lastDecision,
    fetchPending, fetchMode, fetchHistory, setMode, decide, mine, undoProposal, clearError, dismissDecision,
  } = useEvolutionStore()

  const {
    data: approvalsData,
    fetchApprovals,
  } = useApprovalsStore()

  const activeWorkspace = useSessionListStore((s) => s.activeWorkspace)

  const [notice, setNotice] = useState<Notice | null>(null)
  const [busyCandidate, setBusyCandidate] = useState('')
  const [undoingId, setUndoingId] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flash = (n: Notice) => {
    setNotice(n)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 6000)
  }

  useEffect(() => {
    void fetchMode()
    void fetchPending()
    void fetchHistory()
    void fetchApprovals()
  }, [fetchMode, fetchPending, fetchHistory, fetchApprovals, activeWorkspace])

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  useEffect(() => {
    if (!lastDecision) return
    if (lastDecision.status === 'rejected') {
      flash({ tone: 'muted', text: `已忽略该建议（${policy.rejectCooldownDays || 7} 天内不再就此提醒）` })
    } else if (lastDecision.applied) {
      flash({ tone: 'ok', text: '习惯已采纳并永久记入知识库' })
    } else {
      flash({
        tone: 'warn',
        text: `写入失败: ${lastDecision.error || '—'}`,
      })
    }
    dismissDecision()
  }, [lastDecision, policy.rejectCooldownDays, dismissDecision])

  const handleMine = async () => {
    const created = await mine()
    await fetchApprovals()
    flash(created > 0
      ? { tone: 'ok', text: `扫描完成，新提炼出 ${created} 条好习惯建议` }
      : { tone: 'muted', text: '暂无新的高频信号，继续保持' })
  }

  const handleApproveAll = async () => {
    for (const p of pending) {
      await decide(p.id, true)
    }
    await fetchApprovals()
  }

  const handleRejectAll = async () => {
    for (const p of pending) {
      await decide(p.id, false)
    }
    await fetchApprovals()
  }

  const actCandidate = async (id: string, action: 'approve' | 'reject' | 'rollback') => {
    setBusyCandidate(id + action)
    try {
      await apiFetch(`${API_BASE}/api/skills/candidates/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (action === 'approve' || action === 'rollback') {
        await useSkillStore.getState().fetchSkills()
      }
    } finally {
      setBusyCandidate('')
      await fetchApprovals()
    }
  }

  const handleUndo = async (id: string) => {
    if (undoingId) return
    if (!window.confirm('确定要撤销该规则并回滚对应的配置修改吗？')) return
    setUndoingId(id)
    try {
      const res = await undoProposal(id)
      if (res.ok) {
        flash({ tone: 'ok', text: '已成功撤销并回滚该规则变更' })
      } else {
        flash({ tone: 'warn', text: `撤销失败: ${res.error || '未知错误'}` })
      }
    } finally {
      setUndoingId(null)
    }
  }

  const skillCandidates = approvalsData.skillCandidates || []

  // 智能去重与聚合：同一目标文件下，相同草稿或相同语义的建议自动聚合，合并命中频次
  const deduplicatedPending = useMemo(() => {
    const map = new Map<string, Proposal>()
    for (const p of pending) {
      const cleanDraft = (p.draft || '').trim()
      const key = `${p.targetFile || 'AGENTS.md'}_${p.kind || ''}_${cleanDraft}`
      if (map.has(key)) {
        const existing = map.get(key)!
        existing.hits = (existing.hits || 1) + (p.hits || 1)
      } else {
        map.set(key, { ...p })
      }
    }
    return Array.from(map.values())
  }, [pending])

  const totalPendingCount = skillCandidates.length + deduplicatedPending.length
  const acceptedProposals = useMemo(() => {
    return history.filter((p) => p.status === 'accepted')
  }, [history])

  const filteredLibrary = useMemo(() => {
    return acceptedProposals.filter((p) => {
      if (scopeFilter !== 'all' && p.targetFile !== scopeFilter) return false
      if (!searchQuery.trim()) return true
      const q = searchQuery.toLowerCase()
      return (
        (p.userTitle || '').toLowerCase().includes(q) ||
        (p.userAdvice || '').toLowerCase().includes(q) ||
        (p.draft || '').toLowerCase().includes(q) ||
        (p.toolName || '').toLowerCase().includes(q)
      )
    })
  }, [acceptedProposals, scopeFilter, searchQuery])

  const MODE_SEGMENTS: Array<Segment<EvolutionMode>> = [
    { id: 'off', label: '关闭' },
    { id: 'cautious', label: '谨慎' },
    { id: 'active', label: '积极' },
  ]

  const PAGE_TABS: Array<Segment<PageTab>> = [
    {
      id: 'pending',
      label: totalPendingCount > 0 ? `待确认建议 (${totalPendingCount})` : '待确认建议',
    },
    {
      id: 'library',
      label: acceptedProposals.length > 0 ? `已生效习惯 (${acceptedProposals.length})` : '已生效习惯',
    },
    { id: 'settings', label: '学习设置' },
  ]

  const errorRows = (Object.keys(errors) as Array<keyof typeof errors>)
    .filter((k) => errors[k])
    .map((k) => ({ key: k, text: errors[k] as string }))

  return (
    <div className="container mx-auto py-6 px-4 max-w-5xl space-y-5 animate-fade-in select-none">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/50">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-primary/10 text-primary border border-primary/20 shadow-2xs">
              <Dna size={20} className="stroke-[2.2]" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
              AI 习惯与自进化
            </h1>
            {totalPendingCount > 0 && (
              <Badge variant="outline" className="rounded-md font-mono text-[11px] bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30 font-semibold px-2 py-0.5">
                {totalPendingCount}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 ml-0.5">
            从日常执行经验中自动提炼好习惯，经您确认后生效，持续打造更聪明的 Agent。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleMine}
            disabled={mining || refreshing || mode === 'off'}
            className="rounded-lg h-8 px-3 text-xs font-semibold border-border/80 bg-card shadow-2xs hover:bg-accent/40 gap-1.5 shrink-0"
          >
            <RefreshCw className={cn('w-3.5 h-3.5 text-primary', (mining || refreshing) && 'animate-spin')} />
            <span>{mining ? '扫描中…' : '立即扫描新习惯'}</span>
          </Button>
        </div>
      </div>

      {/* Notice bar */}
      {notice && (
        <div
          className={cn(
            'flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl border text-xs shadow-2xs animate-fade-in',
            notice.tone === 'ok' && 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400',
            notice.tone === 'warn' && 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400',
            notice.tone === 'muted' && 'bg-muted/60 border-border text-muted-foreground',
          )}
        >
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} className="p-0.5 hover:opacity-70">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Error banner */}
      {errorRows.length > 0 && (
        <div className="space-y-2">
          {errorRows.map((row) => (
            <div
              key={row.key}
              className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive shadow-2xs"
            >
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span className="flex-1">{row.text}</span>
              <button
                type="button"
                onClick={() => clearError(row.key)}
                className="p-1 hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Top Tabs Switcher */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <SegmentedControl
          segments={PAGE_TABS}
          value={activeTab}
          onChange={(v) => setActiveTab(v)}
          layoutId="evolution-main-tabs"
          className="w-full sm:w-auto"
        />


        {activeTab === 'library' && (
          <div className="flex items-center gap-2 ml-auto w-full sm:w-auto">
            <div className="relative flex-1 sm:w-48">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索已生效习惯…"
                className="w-full h-8 pl-8 pr-3 text-xs bg-muted/40 border border-border/60 rounded-lg outline-none focus:ring-1 focus:ring-primary/40 text-foreground"
              />
            </div>
            <select
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value as any)}
              className="h-8 px-2 text-xs bg-muted/40 border border-border/60 rounded-lg outline-none text-muted-foreground focus:ring-1 focus:ring-primary/40"
            >
              <option value="all">全部范围</option>
              <option value="AGENTS.md">全局规范 (AGENTS.md)</option>
              <option value="MEMORY.md">项目知识库 (MEMORY.md)</option>
            </select>
          </div>
        )}
      </div>

      {/* ─────────────────── TAB 1: 待确认建议 (Inbox) ─────────────────── */}
      {activeTab === 'pending' && (
        <div className="space-y-4">
          {/* 技能候选审批 */}
          {skillCandidates.length > 0 && (
            <section className="space-y-2.5">
              <div className="flex items-center gap-2 px-1">
                <Sparkles className="w-4 h-4 text-primary" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">
                  新技能候选
                </h3>
                <span className="text-xs text-muted-foreground">({skillCandidates.length})</span>
              </div>
              <div className="grid grid-cols-1 gap-2">
                {skillCandidates.map((c: ApprovalSkillCandidate) => (
                  <div key={c.id} className="p-3.5 rounded-xl border border-border/80 bg-card shadow-2xs hover:shadow-xs hover:border-primary/30 transition-all space-y-2">
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <Badge variant="outline" className="rounded-md text-[10px] font-mono bg-warning/15 text-warning border-warning/30 px-1.5 py-0.5">
                        {c.status ?? 'staged'}
                      </Badge>
                      <span className="text-[13px] font-semibold text-foreground">{c.name}</span>
                      {c.version ? (
                        <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">v{c.version.slice(0, 8)}</span>
                      ) : null}
                      <div className="ml-auto flex items-center gap-1.5">
                        <Button size="sm" variant="ghost" disabled={busyCandidate !== ''}
                          onClick={() => void actCandidate(c.id, 'reject')}
                          className="rounded-lg h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1">
                          <XCircle className="w-3.5 h-3.5" /> 暂不上线
                        </Button>
                        <Button size="sm" disabled={busyCandidate !== ''}
                          onClick={() => void actCandidate(c.id, 'approve')}
                          className="rounded-lg h-7 px-3 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 gap-1 shadow-2xs">
                          <ShieldCheck className="w-3.5 h-3.5" /> 批准上线
                        </Button>
                        {c.status === 'active' && (
                          <Button size="sm" variant="outline" disabled={busyCandidate !== ''}
                            onClick={() => void actCandidate(c.id, 'rollback')}
                            className="rounded-lg h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive gap-1">
                            <RotateCcw className="w-3.5 h-3.5" /> 下线回滚
                          </Button>
                        )}
                      </div>
                    </div>
                    {c.description ? (
                      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{c.description}</p>
                    ) : null}
                    {c.gate_report && Object.keys(c.gate_report).length > 0 && (
                      <div className="rounded-lg border border-border/50 bg-muted/40 p-2 space-y-1">
                        {Object.entries(c.gate_report).map(([gate, raw]) => {
                          const g = readGate(raw)
                          return (
                            <div key={gate} className="flex items-start gap-2 text-[11px]">
                              <span className={cn(
                                'font-mono font-semibold',
                                g.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
                                g.tone === 'fail' && 'text-destructive',
                                g.tone === 'info' && 'text-muted-foreground')}>
                                {g.mark} {gate}
                              </span>
                              <span className="text-muted-foreground">{g.detail}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 习惯与经验建议列表 */}
          {deduplicatedPending.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-primary" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">
                    待审规则提案
                  </h3>
                  <Badge variant="outline" className="text-[10px] font-mono bg-muted text-muted-foreground border-border/50">
                    {deduplicatedPending.length}
                  </Badge>
                </div>
                {deduplicatedPending.length > 1 && (
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleRejectAll}
                      className="h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg"
                    >
                      全部忽略
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleApproveAll}
                      className="h-7 px-3 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 shadow-2xs gap-1"
                    >
                      <CheckCheck size={13} />
                      全部采纳并记住 ({deduplicatedPending.length})
                    </Button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3">
                {deduplicatedPending.map((p) => (
                  <HabitProposalCard
                    key={p.id}
                    proposal={p}
                    busy={busyIds.has(p.id)}
                    cooldownDays={policy.rejectCooldownDays}
                    onAccept={(draft) => void decide(p.id, true, draft)}
                    onReject={() => void decide(p.id, false)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* 空状态 */}
          {totalPendingCount === 0 && (
            <Card className="rounded-2xl border-border/70 bg-card shadow-2xs">
              <CardContent className="p-10 flex flex-col items-center gap-2.5 text-center">
                <div className="w-10 h-10 rounded-full bg-muted/60 flex items-center justify-center text-muted-foreground/60 border border-border/40">
                  <Inbox className="w-5 h-5" />
                </div>
                <p className="text-sm font-semibold text-foreground">暂无待确认建议</p>
                <p className="text-xs text-muted-foreground max-w-md leading-relaxed">
                  当前没有待审批的规则或技能。Agent 在后续日常任务执行与复盘中识别出好习惯时，会在此向您呈报。
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ─────────────────── TAB 2: 已生效习惯库 (Library) ─────────────────── */}
      {activeTab === 'library' && (
        <div className="space-y-3">
          {filteredLibrary.length > 0 ? (
            <div className="grid grid-cols-1 gap-2.5">
              {filteredLibrary.map((p) => {
                const targetScope = p.targetFile === 'AGENTS.md'
                  ? '全局执行规范'
                  : p.targetFile === 'MEMORY.md'
                    ? '项目知识库'
                    : (p.targetFile || '项目规则')
                return (
                  <div
                    key={p.id}
                    className="p-3.5 rounded-xl border border-border/70 bg-card/85 shadow-2xs hover:shadow-xs transition-all space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-[10px] px-2 py-0.5">
                          已生效
                        </Badge>
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground font-mono bg-muted/50 px-2 py-0.5 rounded border border-border/40">
                          <FileText className="w-3 h-3 text-primary/70" />
                          <span>{targetScope}</span>
                        </span>
                        {p.effect && (
                          <Badge variant="outline" className="text-[10px] text-sky-600 dark:text-sky-400 border-sky-500/30 bg-sky-500/10">
                            {p.effect === 'effective' ? '复发已清零' : p.effect === 'improving' ? '复发下降中' : '未解决问题'}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground/60 font-mono">
                          采纳于 {relativeTime(p.decidedAt || p.createdAt)}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1 rounded transition-colors"
                          onClick={() => handleUndo(p.id)}
                          disabled={undoingId === p.id}
                          title="撤销并回滚此规则"
                        >
                          <RotateCcw className={cn('w-3 h-3', undoingId === p.id && 'animate-spin')} />
                          <span>{undoingId === p.id ? '撤销中…' : '撤销'}</span>
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <h4 className="text-xs font-bold text-foreground">{p.userTitle || '执行准则'}</h4>
                      <p className="text-xs text-foreground/90 font-medium leading-relaxed bg-muted/30 p-2.5 rounded-lg border border-border/40">
                        「{p.userAdvice || p.draft}」
                      </p>
                    </div>

                    {p.userReason && (
                      <p className="text-[11px] text-muted-foreground px-0.5">
                        {p.userReason}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <Card className="rounded-2xl border-border/70 bg-card shadow-2xs">
              <CardContent className="p-10 flex flex-col items-center gap-2.5 text-center">
                <div className="w-10 h-10 rounded-full bg-muted/60 flex items-center justify-center text-muted-foreground/60 border border-border/40">
                  <BookOpen className="w-5 h-5" />
                </div>
                <p className="text-sm font-semibold text-foreground">
                  {searchQuery || scopeFilter !== 'all' ? '未找到匹配的生效习惯' : '尚未沉淀已生效习惯'}
                </p>
                <p className="text-xs text-muted-foreground max-w-md leading-relaxed">
                  在「待确认建议」中采纳规则后，将永久写入您的全局规范或项目知识库，并在此集中呈现。
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ─────────────────── TAB 3: 学习设置与机制 ─────────────────── */}
      {activeTab === 'settings' && (
        <div className="space-y-4">
          {/* 学习灵敏度设置 */}
          <div className="p-4 rounded-xl border border-border/80 bg-card shadow-2xs space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <h3 className="text-xs font-bold tracking-tight text-foreground">
                  学习灵敏度
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  控制 Agent 在后台任务中自动总结规则与提炼建议的频率
                </p>
              </div>
              <SegmentedControl
                segments={MODE_SEGMENTS}
                value={mode}
                onChange={(v) => void setMode(v)}
                layoutId="evolution-mode-switch"
                className="self-start sm:self-center min-w-[200px]"
              />
            </div>

            {/* 当前档位运行规则说明 */}
            <div className="rounded-xl bg-muted/35 border border-border/50 p-3 text-xs text-muted-foreground leading-relaxed">
              <div className="text-foreground font-medium mb-1">
                {mode === 'cautious' && '当前运行策略：谨慎模式（默认推荐）'}
                {mode === 'active' && '当前运行策略：积极模式'}
                {mode === 'off' && '当前运行策略：已暂停后台提炼'}
              </div>
              <p>
                {mode === 'cautious' &&
                  '当同一类工具调用或操作问题在后台任务中重复出现 5 次以上时，系统才会提炼出待审建议，最多暂存 5 条。忽略的建议在 14 天内不会再次提醒，最大限度减少对日常使用的打扰。'}
                {mode === 'active' &&
                  '当同一操作问题出现 3 次即提炼建议，最多暂存 10 条待审项，适合在刚接入新项目或希望快速建立工作流规范的阶段使用。'}
                {mode === 'off' &&
                  '系统暂停在后台自动分析执行日志并生成新建议。您在对话中明确发起的纠偏与习惯指定不受影响，仍会就地生成卡片。'}
              </p>
            </div>
          </div>

          {/* 习惯沉淀途径：双列对照卡片 */}
          <div className="space-y-2">
            <div className="px-0.5">
              <h4 className="text-xs font-bold tracking-tight text-foreground">
                习惯沉淀途径
              </h4>
              <p className="text-[11px] text-muted-foreground">
                了解 Agent 如何理解您的偏好并将经验沉淀为长期规则
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* 途径 1：对话即时反馈 */}
              <div className="p-3.5 rounded-xl border border-border/70 bg-card shadow-2xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">对话即时反馈</span>
                  <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground border-border/60 bg-muted/40">
                    即时生效
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  在日常聊天中，只要您明确纠正 Agent 的处理方式、指出偏差或提出习惯要求，系统会在对话中直接生成待审卡片，确认后立刻写入项目规范。
                </p>
                <div className="text-[11px] text-muted-foreground/80 font-mono bg-muted/30 px-2.5 py-1.5 rounded-lg border border-border/40">
                  例：“以后所有截图统一保存在 output 目录”
                </div>
              </div>

              {/* 途径 2：任务自动提炼 */}
              <div className="p-3.5 rounded-xl border border-border/70 bg-card shadow-2xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">任务自动提炼</span>
                  <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground border-border/60 bg-muted/40">
                    模式汇总
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  在多轮自动化任务执行中，系统会自动统计工具调用频次与重试模式。当某种规律达到当前灵敏度档位阈值时，会自动生成一条优化建议呈现在待审列表中。
                </p>
                <div className="text-[11px] text-muted-foreground/80 font-mono bg-muted/30 px-2.5 py-1.5 rounded-lg border border-border/40">
                  例：检测到网页请求多次受限，提炼为自动改用浏览器
                </div>
              </div>
            </div>
          </div>

          {/* 数据概览 */}
          <div className="space-y-2 pt-1">
            <div className="px-0.5">
              <h4 className="text-xs font-bold tracking-tight text-foreground">
                数据概览
              </h4>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div
                onClick={() => totalPendingCount > 0 && setActiveTab('pending')}
                className={cn(
                  'p-3.5 rounded-xl border border-border/80 bg-card shadow-2xs space-y-1 transition-all',
                  totalPendingCount > 0
                    ? 'cursor-pointer hover:border-primary/40 hover:shadow-xs'
                    : 'opacity-90'
                )}
              >
                <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
                  <span>待确认建议</span>
                  {totalPendingCount > 0 && (
                    <span className="text-[10px] text-primary hover:underline">前往审核 →</span>
                  )}
                </div>
                <div className="text-xl font-bold font-mono text-foreground tabular-nums">
                  {totalPendingCount}
                </div>
                <div className="text-[10px] text-muted-foreground/70">
                  {totalPendingCount > 0 ? '等待您的确认' : '暂无待审批项'}
                </div>
              </div>

              <div
                onClick={() => counts.accepted > 0 && setActiveTab('library')}
                className={cn(
                  'p-3.5 rounded-xl border border-border/80 bg-card shadow-2xs space-y-1 transition-all',
                  counts.accepted > 0
                    ? 'cursor-pointer hover:border-emerald-500/40 hover:shadow-xs'
                    : 'opacity-90'
                )}
              >
                <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
                  <span>已生效习惯</span>
                  {counts.accepted > 0 && (
                    <span className="text-[10px] text-muted-foreground hover:underline">查看列表 →</span>
                  )}
                </div>
                <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 tabular-nums">
                  {counts.accepted}
                </div>
                <div className="text-[10px] text-muted-foreground/70">
                  已记入项目规范与知识库
                </div>
              </div>

              <div className="p-3.5 rounded-xl border border-border/80 bg-card shadow-2xs space-y-1">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
                  <span>已忽略建议</span>
                </div>
                <div className="text-xl font-bold font-mono text-muted-foreground tabular-nums">
                  {counts.rejected}
                </div>
                <div className="text-[10px] text-muted-foreground/70">
                  处于 14 天防打扰冷却期
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
