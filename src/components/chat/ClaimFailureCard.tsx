// src/components/chat/ClaimFailureCard.tsx
// 「指认闭环」（U3）认领失败卡。
//
// agent 对"把刚才那个页面的表单填了"发起 fail-closed 认领失败后，拒绝消息以
// 工具输出文本形态出现在 ActivityFeed 的工具调用卡里。本卡据协议原文渲染
// 「旧快照 → 新现状」对照；kind=changed 且能拿到 taskId/objectId 时给一键
// 重新指认（requoteAndClaim），成功后把确认消息回填 Composer（CustomEvent，
// Composer.tsx 监听 COMPOSER_INSERT_EVENT）。拿不到 taskId 就诚实降级为
// 「复制引用信息」——绝不编造会话号。
//
// 文案纪律：message 是协议原文，原样渲染不加工；第二次认领再被拒也如实
// 呈现新 message，且绝不清空旧对照。新功能串用组件内中文常量（对齐
// AskUserPanel 的手法），不改全局 i18n。
import { useCallback, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Check, RefreshCw, Loader2 } from 'lucide-react'
import {
  formatClaimRef,
  requoteAndClaim,
  requestComposerInsert,
  type ClaimFailureInfo,
} from '../../lib/claimRef'

/** 组件内中文文案常量（不改全局 i18n）。 */
export const CLAIM_CARD_COPY = {
  changedTitle: '引用的标签已变化——已拒绝近似接管',
  missingTitle: '引用的标签已关闭',
  foreignTitle: '引用的标签不属于当前任务会话',
  oldSnapshot: '引用时（旧快照）',
  newState: '当前（实际现状）',
  unknownTitle: '（无标题）',
  missingHint: '该标签已关闭，可用输入框「引用标签」重新选择',
  retry: '重新指认当前状态',
  retrying: '正在重新指认…',
  copyRef: '复制引用信息',
  copied: '已复制',
  copyTitle: '复制当前状态的标签引用，可粘贴给代理重新认领',
  claimed: '已重新指认',
  claimedHint: '确认消息已填入输入框，发送即可继续',
  tabGone: '该标签也已关闭',
} as const

/** 重试流程的视图状态（导出供 node 环境直接渲染各状态）。 */
export interface ClaimRetryView {
  phase: 'idle' | 'claiming' | 'claimed' | 'failed'
  /** 重试时标签已从当前会话消失。 */
  tabGone?: boolean
  /** 第二次认领被拒的协议原文（原样）。 */
  secondMessage?: string
  /** 拉列表/认领抛出的程序错误消息。 */
  errorMessage?: string
  /** 成功认领后的新回执。 */
  claimedTab?: { tab_id: string; title: string; url: string }
}

export interface ClaimFailureCardProps {
  fail: ClaimFailureInfo
  /** 当前任务/会话号（ActivityFeed 从调用参数 target_ref 解析；解析不出为 null）。 */
  taskId?: string | null
  /** 认领对象号（同上来源；missing 文案里自带，可省）。 */
  objectId?: string | null
}

export function ClaimFailureCard({ fail, taskId, objectId }: ClaimFailureCardProps) {
  const [view, setView] = useState<ClaimRetryView>({ phase: 'idle' })
  const oid = objectId || fail.objectId || ''

  const retry = useCallback(async () => {
    if (!taskId || !oid) return
    setView({ phase: 'claiming' })
    const outcome = await requoteAndClaim(taskId, oid)
    if (outcome.outcome === 'claimed') {
      // 成功：卡片转成功态 + 回填 Composer 确认消息（旧对照保留在上方）。
      setView({ phase: 'claimed', claimedTab: outcome.tab })
      requestComposerInsert(outcome.message)
    } else if (outcome.outcome === 'tab-gone') {
      setView({ phase: 'failed', tabGone: true })
    } else if (outcome.outcome === 'rejected') {
      setView({ phase: 'failed', secondMessage: outcome.message })
    } else {
      setView({ phase: 'failed', errorMessage: outcome.message })
    }
  }, [taskId, oid])

  return <ClaimFailureCardView fail={fail} taskId={taskId} objectId={oid} view={view} onRetry={retry} />
}

export interface ClaimFailureCardViewProps {
  fail: ClaimFailureInfo
  taskId?: string | null
  objectId?: string | null
  view?: ClaimRetryView
  onRetry?: () => void
}

/** 纯渲染视图：状态全部来自 props，node 环境（react-dom/server）可测。 */
export function ClaimFailureCardView({
  fail,
  taskId,
  objectId,
  view = { phase: 'idle' },
  onRetry,
}: ClaimFailureCardViewProps) {
  const [copied, setCopied] = useState(false)
  const t = CLAIM_CARD_COPY

  const title = fail.kind === 'changed'
    ? t.changedTitle
    : fail.kind === 'missing'
      ? t.missingTitle
      : t.foreignTitle

  // 降级复制：优先引用"当前现状"（重新指认才有意义），没有对象号就复制原文。
  const copyText = objectId
    ? formatClaimRef({
        tab_id: objectId,
        title: fail.newTitle || fail.oldTitle || '',
        url: fail.newUrl || fail.oldUrl || '',
      })
    : fail.raw
  const handleCopy = () => {
    navigator.clipboard?.writeText(copyText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* 剪贴板不可用 → 静默，按钮状态复位 */ })
  }

  const canRetry = fail.kind === 'changed' && !!taskId && !!objectId

  return (
    <div
      data-testid="claim-failure-card"
      className="mt-1 rounded-xl border border-amber-500/40 bg-amber-500/[0.06] dark:bg-amber-500/[0.08] overflow-hidden"
    >
      {/* 标题行 */}
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1.5">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        <span className="text-[11.5px] font-medium text-foreground/90">{title}</span>
      </div>

      {/* 协议原文（原样渲染，不加工） */}
      <div className="px-3 pb-2">
        <p className="font-mono text-[10.5px] leading-relaxed text-muted-foreground break-all select-text">
          {fail.raw}
        </p>
      </div>

      {/* changed：旧快照 vs 新现状 两栏对照 */}
      {fail.kind === 'changed' && (
        <div className="px-3 pb-2.5">
          <div className="grid grid-cols-2 gap-2">
            <div
              data-testid="claim-old-col"
              className="rounded-lg border border-border/50 bg-background/60 px-2.5 py-1.5 min-w-0"
            >
              <div className="text-[10px] font-medium text-muted-foreground/70 mb-1 select-none">
                {t.oldSnapshot}
              </div>
              <div className="text-[11px] text-foreground/85 truncate" title={fail.oldTitle}>
                {fail.oldTitle || t.unknownTitle}
              </div>
              <div className="font-mono text-[10px] text-muted-foreground/80 truncate" title={fail.oldUrl}>
                {fail.oldUrl}
              </div>
            </div>
            <div
              data-testid="claim-new-col"
              className="rounded-lg border border-primary/25 bg-primary/[0.04] px-2.5 py-1.5 min-w-0"
            >
              <div className="text-[10px] font-medium text-muted-foreground/70 mb-1 select-none">
                {t.newState}
              </div>
              <div className="text-[11px] text-foreground/90 truncate" title={fail.newTitle}>
                {fail.newTitle || t.unknownTitle}
              </div>
              <div className="font-mono text-[10px] text-muted-foreground/80 truncate" title={fail.newUrl}>
                {fail.newUrl}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* missing：指引入口（无重试按钮——对象已不存在，重试必然再失败） */}
      {fail.kind === 'missing' && (
        <div className="px-3 pb-2.5">
          <p className="text-[11px] text-muted-foreground">{t.missingHint}</p>
        </div>
      )}

      {/* 重试区（仅 changed：拿得到 taskId/objectId 给重试，否则降级复制） */}
      {fail.kind === 'changed' && (
        <div className="flex items-center gap-2 px-3 pb-2.5">
          {canRetry ? (
            <button
              type="button"
              data-testid="claim-retry-button"
              onClick={onRetry}
              disabled={view.phase === 'claiming'}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 border border-amber-500/30 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {view.phase === 'claiming'
                ? <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                : <RefreshCw className="h-3 w-3 shrink-0" />}
              {view.phase === 'claiming' ? t.retrying : t.retry}
            </button>
          ) : (
            <button
              type="button"
              data-testid="claim-copy-button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/50 cursor-pointer"
              title={t.copyTitle}
            >
              {copied ? <Check className="h-3 w-3 text-emerald-500 shrink-0" /> : <Copy className="h-3 w-3 shrink-0" />}
              {copied ? t.copied : t.copyRef}
            </button>
          )}
        </div>
      )}

      {/* 重试结果（旧对照永远保留在上方——绝不清空） */}
      {view.phase === 'claimed' && view.claimedTab && (
        <div
          data-testid="claim-success-note"
          className="flex items-start gap-1.5 px-3 py-2 border-t border-border/40 bg-emerald-500/[0.06]"
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-[11.5px] font-medium text-foreground/90">
              {t.claimed}
              <span className="ml-1 font-normal text-muted-foreground">{t.claimedHint}</span>
            </div>
            <div className="text-[11px] text-foreground/80 truncate" title={view.claimedTab.title}>
              {view.claimedTab.title || view.claimedTab.tab_id}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground/80 truncate" title={view.claimedTab.url}>
              {view.claimedTab.url}
            </div>
          </div>
        </div>
      )}
      {view.phase === 'failed' && view.tabGone && (
        <div
          data-testid="claim-tab-gone"
          className="px-3 py-2 border-t border-border/40 text-[11px] text-rose-500"
        >
          {t.tabGone}
        </div>
      )}
      {view.phase === 'failed' && view.secondMessage && (
        <div
          data-testid="claim-second-message"
          className="px-3 py-2 border-t border-border/40"
        >
          <p className="font-mono text-[10.5px] leading-relaxed text-amber-600 dark:text-amber-400 break-all select-text">
            {view.secondMessage}
          </p>
        </div>
      )}
      {view.phase === 'failed' && view.errorMessage && (
        <div
          data-testid="claim-error-message"
          className="px-3 py-2 border-t border-border/40 text-[11px] text-rose-500 break-all"
        >
          {view.errorMessage}
        </div>
      )}
    </div>
  )
}

export default ClaimFailureCard
