// src/components/chat/EvolutionNotice.tsx
// 进化感知芯片 / 学习回执 (LearningReceipt) & 嵌入式进化卡
// §13.4/13.5 & Phase 24:
// 1. 实现原生嵌入式系统卡片五态生命周期 (evaluating -> receipt -> actionable -> result -> rollback);
// 2. 渐进式披露 (L1标题/数量 -> L2学到了什么/为什么/范围/影响 -> L3证据链与状态 -> L4详情);
// 3. 支持单 item 与多 item 独立处置及批量全部采纳/暂缓，直接调用 /api/learning-items/{id}/{action};
// 4. 出现错误时内联呈现真实失败状态，不假装成功；
// 5. 稳定重试语义 operation key 与乐观锁 version 校验；
// 6. 点击“查看本次学习”通过 openAndRevealSidePanel 展开并聚焦右侧栏。

import React, { useState, useRef } from 'react'
import {
  Brain,
  ArrowRight,
  CheckCircle2,
  Undo2,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Check,
  X,
  Clock,
  AlertTriangle,
  FileCode,
  Edit3,
  ListOrdered,
} from 'lucide-react'
import { cn } from '@lib/utils'
import { useSidePanelStore } from '@store/sidePanelStore'
import { apiPost } from '@lib/api'
import type { EvolutionInsight } from '@apptypes/index'

export function EvolutionNotice({ insight }: { insight: EvolutionInsight }) {
  const openAndRevealSidePanel = useSidePanelStore((s) => s.openAndRevealSidePanel)
  const [expanded, setExpanded] = useState(false)
  const [actionStatus, setActionStatus] = useState<string | null>(insight.lifecycle || insight.status || null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState(insight.detail || insight.summary || '')

  // Multi-item individual statuses & stable operation key ref (P1-1 & P1-6 & P1-9)
  const [itemStatuses, setItemStatuses] = useState<Record<string, { status: string; error?: string }>>({})
  const opKeysRef = useRef<Record<string, string>>({})

  const getStableOpKey = (targetId: string, act: string) => {
    // P1-9: Remove card-level version from key to avoid coupling all items to one version
    const k = `${targetId}:${act}`
    if (!opKeysRef.current[k]) {
      opKeysRef.current[k] = `evo-op-${targetId}-${act}`
    }
    return opKeysRef.current[k]
  }

  const isEvaluating =
    insight.kind === 'evaluating' ||
    insight.lifecycle === 'evaluating' ||
    insight.status === 'evaluating' ||
    insight.status === 'validating'
  const isFailed = actionStatus === 'failed' || insight.kind === 'failed' || insight.status === 'failed'
  const isUnknown = actionStatus === 'unknown' || insight.kind === 'unknown' || insight.status === 'unknown'
  const isPublished = actionStatus === 'published' || insight.kind === 'published' || insight.status === 'published' || insight.kind === 'candidate_active'
  const isRejected = actionStatus === 'rejected' || insight.kind === 'rejected' || insight.status === 'rejected'
  const isDeferred = actionStatus === 'deferred' || insight.kind === 'deferred' || insight.status === 'deferred'
  const isRolledBack = actionStatus === 'rolled_back' || insight.kind === 'rolled_back' || insight.status === 'rolled_back'

  const rawItems = insight.learningItems || (insight.itemId ? [insight.itemId] : [])
  const hasMultipleItems = rawItems.length > 1
  const hasItems = rawItems.length > 0
  const isActionable =
    !isPublished && !isRejected && !isRolledBack && !isEvaluating &&
    (insight.notificationPolicy === 'actionable' || insight.kind === 'candidate_staged' || (insight.kind === 'learned' && hasItems))

  // P1-9: Calculate pending items that have not yet reached terminal status
  const pendingItems = rawItems.filter((lid) => {
    const stat = itemStatuses[lid]?.status
    return !stat || !['published', 'rejected', 'deferred', 'rolled_back'].includes(stat)
  })

  const handleOpenSidePanel = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    openAndRevealSidePanel('session_learning')
  }

  const getItemVersion = (targetId: string): number | undefined => {
    const detail = insight.learningItemDetails?.find((d) => d.id === targetId)
    if (detail?.version !== undefined) return detail.version
    if (!hasMultipleItems && insight.version !== undefined) return insight.version
    return undefined
  }

  // Handle single item action
  const handleSingleItemAction = async (
    targetId: string,
    action: 'approve' | 'reject' | 'defer' | 'revoke',
    e?: React.MouseEvent
  ) => {
    e?.stopPropagation()
    setBusy(true)
    setErrorMessage(null)
    const idempotencyKey = getStableOpKey(targetId, action)
    const itemVer = getItemVersion(targetId)

    try {
      const res = await apiPost<{ ok: boolean; applied?: boolean; error?: string; status?: string }>(
        `/api/learning-items/${targetId}/${action}`,
        {
          sessionId: insight.sessionId,
          branchId: insight.branchId,
          version: itemVer,
          idempotencyKey,
          content: action === 'approve' && editing ? editContent : undefined,
        }
      )
      if (res.ok) {
        const nextStat = res.status || (action === 'approve' ? 'published' : action === 'reject' ? 'rejected' : action === 'defer' ? 'deferred' : 'rolled_back')
        setItemStatuses((prev) => ({
          ...prev,
          [targetId]: { status: nextStat },
        }))
        if (!hasMultipleItems) {
          setActionStatus(nextStat)
          setEditing(false)
        }
      } else {
        const err = res.error || `操作失败`
        setItemStatuses((prev) => ({
          ...prev,
          [targetId]: { status: res.status || 'failed', error: err },
        }))
        setErrorMessage(err)
      }
    } catch (err: any) {
      const errTxt = err?.message || '请求失败'
      setItemStatuses((prev) => ({
        ...prev,
        [targetId]: { status: 'failed', error: errTxt },
      }))
      setErrorMessage(errTxt)
    } finally {
      setBusy(false)
    }
  }

  // Handle batch or primary item action (P1-9: skip already-completed items, send each item's version)
  const handleAction = async (action: 'approve' | 'reject' | 'defer' | 'revoke', e?: React.MouseEvent) => {
    e?.stopPropagation()
    setBusy(true)
    setErrorMessage(null)

    if (hasMultipleItems) {
      // P1-5 & P1-9: Only operate on items that haven't reached terminal status; if none pending, do nothing
      if (pendingItems.length === 0) {
        setBusy(false)
        return
      }
      const targets = pendingItems
      let successCount = 0
      let failCount = 0
      let lastErr = ''
      for (const lid of targets) {
        const idempotencyKey = getStableOpKey(lid, action)
        const itemVer = getItemVersion(lid)
        try {
          const res = await apiPost<{ ok: boolean; error?: string; status?: string }>(
            `/api/learning-items/${lid}/${action}`,
            {
              sessionId: insight.sessionId,
              branchId: insight.branchId,
              version: itemVer,
              idempotencyKey,
            }
          )
          if (res.ok) {
            successCount++
            setItemStatuses((prev) => ({
              ...prev,
              [lid]: { status: res.status || (action === 'approve' ? 'published' : action === 'reject' ? 'rejected' : action === 'defer' ? 'deferred' : 'rolled_back') },
            }))
          } else {
            failCount++
            lastErr = res.error || `操作失败`
            setItemStatuses((prev) => ({
              ...prev,
              [lid]: { status: res.status || 'failed', error: lastErr },
            }))
          }
        } catch (err: any) {
          failCount++
          lastErr = err?.message || `请求失败`
          setItemStatuses((prev) => ({
            ...prev,
            [lid]: { status: 'failed', error: lastErr },
          }))
        }
      }
      if (failCount === 0) {
        setActionStatus(action === 'approve' ? 'published' : action === 'reject' ? 'rejected' : action === 'defer' ? 'deferred' : 'rolled_back')
      } else {
        setErrorMessage(`已处理 ${successCount} 项，失败 ${failCount} 项：${lastErr}`)
      }
      setBusy(false)
      return
    }

    const targetId = insight.itemId || rawItems[0]
    if (!targetId) {
      setBusy(false)
      return
    }
    await handleSingleItemAction(targetId, action, e)
  }

  const handleSaveEdit = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setBusy(true)
    setErrorMessage(null)
    const targetId = insight.itemId || rawItems[0]
    if (!targetId) {
      setEditing(false)
      setBusy(false)
      return
    }
    try {
      const idempotencyKey = getStableOpKey(targetId, 'edit')
      const itemVer = getItemVersion(targetId)
      const res = await apiPost<{ ok: boolean; error?: string }>(
        `/api/learning-items/${targetId}/edit`,
        {
          sessionId: insight.sessionId,
          branchId: insight.branchId,
          version: itemVer,
          idempotencyKey,
          content: editContent,
        }
      )
      if (res.ok) {
        setEditing(false)
      } else {
        setErrorMessage(res.error || '保存编辑失败')
      }
    } catch (err: any) {
      setErrorMessage(err?.message || '编辑请求失败')
    } finally {
      setBusy(false)
    }
  }

  // ── 1. Evaluating state: Compact progress ─────────────────────────────────
  if (isEvaluating) {
    return (
      <div className="flex justify-center my-2.5 px-4 select-none">
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3.5 py-1 text-xs text-primary/80">
          <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" />
          <span className="font-medium text-[11px]">系统正在整理这段对话</span>
          <span className="text-[10px] text-muted-foreground">正在判断是否有值得长期保留的经验 · 可继续聊天</span>
        </div>
      </div>
    )
  }

  // ── 2. Header Title & Icon by State ──────────────────────────────────────
  let title = '发现新经验'
  let Icon = Sparkles

  if (isPublished) {
    title = '已确认进化'
    Icon = CheckCircle2
  } else if (isRejected) {
    title = '已忽略学习建议'
    Icon = X
  } else if (isDeferred) {
    title = '已暂不处理'
    Icon = Clock
  } else if (isRolledBack) {
    title = '已回滚'
    Icon = Undo2
  } else if (isFailed || isUnknown) {
    title = '进化未完成'
    Icon = AlertTriangle
  } else if (insight.skillName || insight.candidateId) {
    title = `建议沉淀为技能候选：${insight.skillName || '新技能'}`
    Icon = FileCode
  } else if (isActionable) {
    title = hasMultipleItems ? `进化请求（${rawItems.length} 个学习项）` : '进化请求'
    Icon = Sparkles
  } else {
    const memCount = insight.memoryProposals?.length ?? 0
    const liCount = rawItems.length
    title = `学习回执 · 产生 ${liCount || memCount || 1} 个学习项`
    Icon = Brain
  }

  const scopeLabel = insight.scope === 'global' ? '全局' : insight.scope === 'workspace' ? '当前项目' : '当前会话'

  return (
    <div className="flex flex-col items-center my-2.5 px-4 select-none">
      {/* L1 Chip Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'group inline-flex max-w-[92%] items-center gap-2 rounded-full border px-3.5 py-1.5',
          'text-xs bg-background/85 backdrop-blur-sm cursor-pointer shadow-xs transition-all',
          isPublished
            ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
            : isFailed || isUnknown
            ? 'border-destructive/40 text-destructive bg-destructive/5'
            : isActionable
            ? 'border-primary/40 text-primary hover:border-primary hover:bg-primary/5'
            : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-semibold text-[11px]">{title}</span>
        <span className="truncate max-w-[14rem] text-[11px] opacity-75">
          {insight.why || insight.detail || insight.summary || '点击展开详情'}
        </span>

        {/* Inline Quick Action Buttons for Actionable items */}
        {isActionable && !actionStatus && (
          <div className="flex items-center gap-1 ml-1" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => handleAction('approve', e)}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-primary/15 hover:bg-primary/25 text-primary text-[10px] font-medium transition"
              title="确认进化"
            >
              <Check className="w-2.5 h-2.5" />
              {hasMultipleItems ? '全部采纳' : '采纳'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => handleAction('defer', e)}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-muted text-muted-foreground text-[10px] transition"
              title="暂不处理"
            >
              暂缓
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => handleAction('reject', e)}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive text-[10px] transition"
              title="不需要"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        )}

        {expanded ? (
          <ChevronUp className="h-3 w-3 shrink-0 opacity-60" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        )}
      </div>

      {/* L2/L3 Expanded Evolution Request & Receipt Card */}
      {expanded && (
        <div className="mt-2 w-full max-w-lg p-3.5 rounded-xl border border-border/70 bg-card/95 backdrop-blur-md shadow-md text-xs space-y-3 animate-in fade-in slide-in-from-top-1 duration-150">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/40 pb-2">
            <span className="font-semibold text-foreground flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-primary" />
              {isActionable ? '进化请求' : '自进化学习凭证'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleOpenSidePanel}
                className="text-[11px] text-primary hover:underline flex items-center gap-1 font-medium"
              >
                查看本次学习
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Error Banner if any */}
          {errorMessage && (
            <div className="p-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-[11px] flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Content / Editing */}
          {editing ? (
            <div className="space-y-2">
              <label className="text-[10px] font-medium text-muted-foreground">编辑学习内容：</label>
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full p-2 text-xs rounded border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                rows={3}
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="px-2 py-1 rounded text-[10px] text-muted-foreground hover:bg-muted"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleSaveEdit}
                  className="px-2 py-1 rounded text-[10px] bg-primary text-primary-foreground font-medium"
                >
                  保存草稿
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-[11px]">
              <div>
                <span className="text-muted-foreground block text-[10px] font-medium">学到了什么</span>
                <p className="font-medium text-foreground leading-relaxed">
                  {insight.detail || insight.summary || '提取到对话关键事实与经验'}
                </p>
              </div>

              {insight.why && (
                <div>
                  <span className="text-muted-foreground block text-[10px] font-medium">为什么</span>
                  <p className="text-muted-foreground leading-relaxed">{insight.why}</p>
                </div>
              )}

              {/* Multi-item Breakdown List (P1-6) */}
              {hasMultipleItems && (
                <div className="p-2 rounded-lg bg-muted/30 border border-border/40 space-y-1.5">
                  <div className="flex items-center gap-1 text-[10px] font-semibold text-foreground/80">
                    <ListOrdered className="w-3 h-3" />
                    <span>本组学习产物明细（{rawItems.length} 项）：</span>
                  </div>
                  <div className="space-y-1">
                    {rawItems.map((lid, idx) => {
                      const itemDetail = insight.learningItemDetails?.find(d => d.id === lid)
                      const itemStat = itemStatuses[lid]?.status || (isPublished ? 'published' : isRejected ? 'rejected' : isDeferred ? 'deferred' : 'pending')
                      const label = itemDetail?.content ? (itemDetail.content.length > 35 ? itemDetail.content.slice(0, 35) + '…' : itemDetail.content) : lid
                      return (
                        <div key={lid} className="flex items-center justify-between p-1 rounded bg-background/60 text-[10px]">
                          <span className="truncate max-w-[15rem] font-mono text-muted-foreground" title={itemDetail?.content || lid}>
                            #{idx + 1} {label}
                          </span>
                          <div className="flex items-center gap-1">
                            {itemStat === 'published' ? (
                              <span className="text-emerald-600 dark:text-emerald-400 font-medium">已采纳</span>
                            ) : itemStat === 'rejected' ? (
                              <span className="text-muted-foreground">已忽略</span>
                            ) : itemStat === 'deferred' ? (
                              <span className="text-amber-600 font-medium">已暂缓</span>
                            ) : (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={(e) => handleSingleItemAction(lid, 'approve', e)}
                                  className="px-1.5 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary text-[9px]"
                                >
                                  采纳
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={(e) => handleSingleItemAction(lid, 'defer', e)}
                                  className="px-1.5 py-0.5 rounded hover:bg-muted text-muted-foreground text-[9px]"
                                >
                                  暂缓
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={(e) => handleSingleItemAction(lid, 'reject', e)}
                                  className="px-1.5 py-0.5 rounded hover:bg-destructive/10 text-muted-foreground text-[9px]"
                                >
                                  忽略
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 pt-1 text-[10px]">
                <div className="p-1.5 rounded bg-muted/40 border border-border/30">
                  <span className="text-muted-foreground block font-medium">作用范围</span>
                  <span className="font-semibold text-foreground">{scopeLabel}</span>
                </div>
                <div className="p-1.5 rounded bg-muted/40 border border-border/30">
                  <span className="text-muted-foreground block font-medium">未来影响</span>
                  <span className="text-foreground">{insight.futureEffect || '后续相关任务将参考此项'}</span>
                </div>
              </div>

              {insight.evidenceSummary && (
                <div className="text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground/80">证据来源：</span>
                  {insight.evidenceSummary}
                </div>
              )}
            </div>
          )}

          {/* Action Footer */}
          <div className="flex items-center justify-between pt-2 border-t border-border/40 text-[11px]">
            {isPublished ? (
              <div className="flex items-center justify-between w-full">
                <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  已写入：{scopeLabel}长期资产
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={(e) => handleAction('revoke', e)}
                  className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1"
                >
                  <Undo2 className="w-3 h-3" />
                  撤销
                </button>
              </div>
            ) : isRejected ? (
              <span className="text-muted-foreground">已忽略此条建议 · 不会改变未来行为</span>
            ) : isDeferred ? (
              <span className="text-muted-foreground">已暂存至待审队列 · 不影响当前对话</span>
            ) : isFailed || isUnknown ? (
              <div className="flex items-center justify-between w-full text-destructive">
                <span>写入未完成，可在右侧栏查看或重试</span>
                <button
                  type="button"
                  onClick={handleOpenSidePanel}
                  className="text-xs underline font-medium"
                >
                  打开本次学习
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(!editing)}
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px]"
                  >
                    <Edit3 className="w-3 h-3" />
                    编辑
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(e) => handleAction('defer', e)}
                    className="text-muted-foreground hover:text-foreground text-[11px]"
                  >
                    暂不处理
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(e) => handleAction('reject', e)}
                    className="text-muted-foreground hover:text-destructive text-[11px]"
                  >
                    不需要
                  </button>
                </div>
                <button
                  type="button"
                  disabled={busy || (hasMultipleItems && pendingItems.length === 0)}
                  onClick={(e) => handleAction('approve', e)}
                  className="px-2.5 py-1 rounded bg-primary text-primary-foreground font-medium text-[11px] shadow-xs hover:bg-primary/90 transition"
                >
                  {hasMultipleItems ? (pendingItems.length < rawItems.length ? `确认剩余 ${pendingItems.length} 项` : '全部确认进化') : '确认进化'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
