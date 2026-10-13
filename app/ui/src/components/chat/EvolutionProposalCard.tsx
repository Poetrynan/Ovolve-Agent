// src/components/chat/EvolutionProposalCard.tsx
// 原生聊天流就地自进化审核卡片 (In-Chat Evolution Proposal Card)
// 支持 [✓ 批准并生效]、[✕ 忽略]、[✎ 调整内容]，并在卡片内就地呈现状态转变，绝不强制跳转离页。

import React, { useState } from 'react'
import {
  Sparkles,
  CheckCircle2,
  XCircle,
  Edit3,
  FileCode,
  Loader2,
  Check,
  X,
  AlertCircle,
  Hash,
} from 'lucide-react'
import { Button } from '@components/ui/button'
import { Badge } from '@components/ui/badge'
import { cn } from '@lib/utils'
import { API_BASE, apiFetch } from '@lib/api'
import type { InlineEvolutionProposal } from '@apptypes/index'

interface Props {
  proposal: InlineEvolutionProposal
  onApproved?: (proposalId: string) => void
  onRejected?: (proposalId: string) => void
}

export function EvolutionProposalCard({ proposal, onApproved, onRejected }: Props) {
  const proposalId = proposal.proposal_id || proposal.id || ''
  const [status, setStatus] = useState<string>(proposal.status || 'pending')
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftContent, setDraftContent] = useState(proposal.proposed_change || proposal.user_advice || '')
  const [error, setError] = useState<string | null>(null)

  const targetFile = proposal.target_file || proposal.targetFile || 'AGENTS.md'
  const triggerType = proposal.trigger_type || 'preference'
  const reason = proposal.reason || proposal.user_reason || '根据会话交互总结出的持续规则'

  const triggerLabelMap: Record<string, { label: string; color: string }> = {
    correction: { label: '用户纠偏', color: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30' },
    preference: { label: '习惯偏好', color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30' },
    workflow: { label: '工作流SOP', color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30' },
    struggle: { label: '受挫优化', color: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30' },
  }

  const trigInfo = triggerLabelMap[triggerType] || triggerLabelMap.preference

  const handleApprove = async () => {
    if (!proposalId) return
    setLoading(true)
    setError(null)
    try {
      const resp = await apiFetch(`${API_BASE}/api/evolution/proposals/${encodeURIComponent(proposalId)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: draftContent }),
      })
      if (!resp.ok) {
        throw new Error(`Approval failed with HTTP ${resp.status}`)
      }
      setStatus('approved')
      setEditing(false)
      onApproved?.(proposalId)
    } catch (err: any) {
      setError(err?.message || '批准规则时发生异常')
    } finally {
      setLoading(false)
    }
  }

  const handleReject = async () => {
    if (!proposalId) return
    setLoading(true)
    setError(null)
    try {
      const resp = await apiFetch(`${API_BASE}/api/evolution/proposals/${encodeURIComponent(proposalId)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!resp.ok) {
        throw new Error(`Rejection failed with HTTP ${resp.status}`)
      }
      setStatus('rejected')
      setEditing(false)
      onRejected?.(proposalId)
    } catch (err: any) {
      setError(err?.message || '忽略规则时发生异常')
    } finally {
      setLoading(false)
    }
  }

  // 1. 已批准终端状态（折叠为优雅的绿色状态条）
  if (status === 'approved') {
    return (
      <div className="my-2 flex items-center justify-between gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs text-emerald-950 dark:text-emerald-200 shadow-xs backdrop-blur-md">
        <div className="flex items-center gap-2 min-w-0">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="font-semibold">自进化规则已生效</span>
          <span className="truncate text-emerald-800/80 dark:text-emerald-300/80 font-mono text-[11px]">
            → 写入 {targetFile}
          </span>
        </div>
        <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-300">
          Approved
        </Badge>
      </div>
    )
  }

  // 2. 已拒绝终端状态（折叠为中性静默状态条）
  if (status === 'rejected') {
    return (
      <div className="my-2 flex items-center justify-between gap-2.5 rounded-xl border border-muted/50 bg-muted/20 px-3.5 py-2 text-xs text-muted-foreground shadow-xs backdrop-blur-md">
        <div className="flex items-center gap-2 min-w-0">
          <XCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">已忽略此自进化提议</span>
          <span className="text-[11px] text-muted-foreground/70">（14 天内不再提示同类签名）</span>
        </div>
        <Badge variant="outline" className="text-[10px] text-muted-foreground border-muted/60">
          Ignored
        </Badge>
      </div>
    )
  }

  // 3. 待决状态（交互式卡片）
  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-amber-500/30 bg-card/95 shadow-md backdrop-blur-xl transition-all ring-1 ring-amber-500/15">
      {/* 头部条带 */}
      <div className="flex items-center justify-between border-b border-border/50 bg-amber-500/10 px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-700 dark:text-amber-300 shadow-2xs">
            <Sparkles className="h-3.5 w-3.5 animate-pulse" />
          </div>
          <span className="text-xs font-semibold text-foreground tracking-tight">
            自进化规则提议
          </span>
          {proposal.signature && (
            <span className="hidden sm:inline-flex font-mono text-[11px] text-muted-foreground/80 truncate max-w-[140px]">
              #{proposal.signature}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span className={cn('px-2 py-0.5 rounded-md text-[10px] font-medium border', trigInfo.color)}>
            {trigInfo.label}
          </span>
          <Badge variant="outline" className="text-[10px] border-border/60 bg-background/50 font-mono">
            {targetFile}
          </Badge>
        </div>
      </div>

      {/* 证据与理由 */}
      <div className="px-4 pt-3 pb-2 space-y-2.5">
        <div className="text-[12px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground mr-1.5">触发依据:</span>
          {reason}
        </div>

        {/* 提议内容对比区 */}
        <div className="rounded-xl border border-border/70 bg-muted/40 p-2.5">
          <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span className="flex items-center gap-1">
              <FileCode className="h-3 w-3 text-amber-600 dark:text-amber-400" />
              提议写入规则 ({targetFile})
            </span>
            {proposal.payload_hash && (
              <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/70 font-mono">
                <Hash className="h-2.5 w-2.5" />
                {proposal.payload_hash.slice(0, 8)}
              </span>
            )}
          </div>

          {editing ? (
            <textarea
              className="w-full rounded-lg border border-border bg-background p-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary min-h-[70px]"
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              placeholder="编辑将要写入的规则条目..."
            />
          ) : (
            <div className="font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-all select-text bg-background/60 p-2 rounded-lg border border-border/40">
              {draftContent}
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-600 dark:text-rose-400">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* 底部操作条 */}
      <div className="flex items-center justify-between border-t border-border/50 bg-background/40 px-4 py-2">
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          disabled={loading}
          className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <Edit3 className="h-3 w-3" />
          <span>{editing ? '取消编辑' : '调整内容'}</span>
        </button>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleReject}
            disabled={loading}
            className="h-7 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg px-2.5"
          >
            <X className="mr-1 h-3 w-3" />
            忽略
          </Button>

          <Button
            size="sm"
            variant="default"
            onClick={handleApprove}
            disabled={loading}
            className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-3 shadow-xs font-medium"
          >
            {loading ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Check className="mr-1 h-3 w-3" />
            )}
            批准并生效
          </Button>
        </div>
      </div>
    </div>
  )
}
