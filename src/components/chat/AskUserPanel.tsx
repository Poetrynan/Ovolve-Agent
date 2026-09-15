import React, { useEffect } from 'react'
import { ShieldAlert, Check, X, Hand } from 'lucide-react'
// 确认卡场景化的决策纯函数层：组件只消费结论。
import {
  ALWAYS_ALLOW_LOCKED_TOOLTIP,
  alwaysAllowState,
  confirmReasonText,
  enterApproves,
  isTakeover,
  scenarioChips,
} from '../../lib/confirmationScenario'

interface AskUserProps {
  title: string
  description?: string
  tool?: string
  onApprove: () => void
  onReject: () => void
  /** 确认停点的场景语义（WS tool_result meta 透传；缺省 = 现状）。 */
  confirmReason?: string
  scenarioTags?: string[]
  allowAlways?: boolean
  handoff?: boolean
  /** 「以后都允许」的持久授权回调；缺省回落到单次 onApprove。 */
  onAlways?: () => void
}

export const AskUserPanel: React.FC<AskUserProps> = ({
  title,
  description,
  tool,
  onApprove,
  onReject,
  confirmReason,
  scenarioTags,
  allowAlways,
  handoff,
  onAlways,
}) => {
  const takeover = isTakeover({ handoff })
  const reason = confirmReasonText({ confirmReason })
  const chips = scenarioChips(scenarioTags)
  const alwaysState = alwaysAllowState({ allowAlways })

  useEffect(() => {
    // 接管卡没有任何可批准/可拒绝的选项——键盘 Enter/Esc 批准路径一并跳过。
    if (!enterApproves({ handoff })) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        onApprove()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        onReject()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onApprove, onReject, handoff])

  // ── 接管提示卡：此操作需要用户亲自执行，零批准按钮 ──────────────────────
  if (takeover) {
    return (
      <div className="my-2.5 p-3 rounded-xl border border-amber-500/50 bg-amber-500/10 dark:bg-amber-500/5 backdrop-blur-xl shadow-xs flex items-center justify-between gap-3 select-none animate-in fade-in slide-in-from-bottom-2 duration-200">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 rounded-lg bg-amber-500/20 text-amber-500 shrink-0">
            <Hand size={18} />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground flex items-center gap-2">
              <span>{title}</span>
              {tool && (
                <span className="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 font-mono text-[10px]">
                  {tool}
                </span>
              )}
            </div>
            {chips.length > 0 && (
              <div className="flex items-center gap-1 pt-1">
                {chips.map((c) => (
                  <span
                    key={c}
                    className="px-1.5 py-0.2 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-[10px] font-medium"
                  >
                    {c}
                  </span>
                ))}
              </div>
            )}
            {(reason || description) && (
              <div className="text-[11px] text-muted-foreground max-w-md pt-0.5 font-sans leading-relaxed">
                {reason || description}
              </div>
            )}
          </div>
        </div>
        <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium shrink-0">
          请你亲自处理
        </span>
      </div>
    )
  }

  return (
    <div className="my-2.5 p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 dark:bg-amber-500/5 backdrop-blur-xl shadow-xs flex items-center justify-between gap-3 select-none animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="p-1.5 rounded-lg bg-amber-500/20 text-amber-500 shrink-0">
          <ShieldAlert size={18} />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground flex items-center gap-2">
            <span>{title}</span>
            {tool && (
              <span className="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 font-mono text-[10px]">
                {tool}
              </span>
            )}
          </div>
          {(chips.length > 0 || reason) && (
            <div className="flex items-center gap-1.5 pt-1 flex-wrap min-w-0">
              {chips.map((c) => (
                <span
                  key={c}
                  className="px-1.5 py-0.2 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-[10px] font-medium"
                >
                  {c}
                </span>
              ))}
              {reason && (
                <span className="text-[11px] text-muted-foreground font-sans truncate max-w-sm">
                  {reason}
                </span>
              )}
            </div>
          )}
          {description && (
            <div className="text-[11px] text-muted-foreground truncate max-w-md font-mono">{description}</div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {alwaysState !== 'absent' && (
          <button
            type="button"
            onClick={alwaysState === 'available' ? (onAlways ?? onApprove) : undefined}
            disabled={alwaysState === 'locked'}
            title={alwaysState === 'locked' ? ALWAYS_ALLOW_LOCKED_TOOLTIP : undefined}
            aria-label={alwaysState === 'locked' ? ALWAYS_ALLOW_LOCKED_TOOLTIP : '以后都允许'}
            className="px-2.5 py-1 rounded-lg text-xs font-medium border transition-all flex items-center gap-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 disabled:hover:bg-transparent"
          >
            <span>以后都允许</span>
          </button>
        )}
        <button
          type="button"
          onClick={onReject}
          className="px-2.5 py-1 rounded-lg text-xs font-medium bg-background/80 hover:bg-background text-muted-foreground hover:text-foreground border border-border/60 transition-all flex items-center gap-1 cursor-pointer"
        >
          <X size={12} />
          <span>Reject (Esc)</span>
        </button>
        <button
          type="button"
          onClick={onApprove}
          className="px-3 py-1 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white shadow-2xs transition-all flex items-center gap-1 cursor-pointer"
        >
          <Check size={12} />
          <span>Allow (Enter)</span>
        </button>
      </div>
    </div>
  )
}

export default AskUserPanel
