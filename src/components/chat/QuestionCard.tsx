import React from 'react'
import { ShieldAlert, Check, X, HelpCircle, Hand } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'
import type { ToolCall } from '../../types/agent'
// 确认卡场景化的决策纯函数层：组件只消费结论。
import {
  ALWAYS_ALLOW_LOCKED_TOOLTIP,
  alwaysAllowState,
  confirmReasonText,
  isTakeover,
  scenarioChips,
} from '../../lib/confirmationScenario'

interface QuestionCardProps {
  toolCall: ToolCall
}

export const QuestionCard: React.FC<QuestionCardProps> = ({ toolCall }) => {
  const respondToToolApproval = useAgentStore((s) => s.respondToToolApproval)

  const isConfirmation = toolCall.status === 'needs_confirmation'
  const questionText = toolCall.args?.question || toolCall.args?.prompt || 'Please confirm execution of this sensitive action:'
  const options: string[] = toolCall.args?.options || []
  const takeover = isTakeover(toolCall)
  const reason = confirmReasonText(toolCall)
  const chips = scenarioChips(toolCall.scenarioTags)
  const alwaysState = alwaysAllowState(toolCall)

  // ── 接管提示卡：此操作需要用户亲自执行，零批准按钮 ──────────────────────
  if (takeover) {
    return (
      <div className="my-3 p-4 rounded-xl glass-panel border border-amber-500/50 bg-amber-950/20 shadow-lg shadow-amber-500/5 text-xs space-y-3">
        <div className="flex items-center gap-2 text-amber-300 font-medium">
          <Hand className="w-4 h-4 text-amber-400" />
          <span>此操作需要你亲自执行</span>
          {toolCall.tool && (
            <span className="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-400 font-mono text-[10px]">
              {toolCall.tool}
            </span>
          )}
        </div>

        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <span
                key={c}
                className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[10.5px] font-medium"
              >
                {c}
              </span>
            ))}
          </div>
        )}

        <p className="text-white/90 leading-relaxed font-sans">
          {reason || '这类动作不该由代理代劳，请你在设备上亲手完成。'}
        </p>

        <p className="text-[11px] text-amber-400/90 font-medium">请你亲自处理</p>
      </div>
    )
  }

  return (
    <div className="my-3 p-4 rounded-xl glass-panel border border-amber-500/30 bg-amber-950/20 shadow-lg shadow-amber-500/5 text-xs space-y-3">
      <div className="flex items-center gap-2 text-amber-300 font-medium">
        {isConfirmation ? <ShieldAlert className="w-4 h-4 text-amber-400" /> : <HelpCircle className="w-4 h-4 text-blue-400" />}
        <span>{isConfirmation ? 'Action Approval Required' : 'OvolveAgent Needs Your Input'}</span>
      </div>

      {(chips.length > 0 || reason) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span
              key={c}
              className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[10.5px] font-medium"
            >
              {c}
            </span>
          ))}
          {reason && (
            <span className="text-white/70 leading-relaxed font-sans">{reason}</span>
          )}
        </div>
      )}

      <p className="text-white/90 leading-relaxed font-sans">{questionText}</p>

      {/* Options or Approve/Reject */}
      {options.length > 0 ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {options.map((opt, idx) => (
            <button
              key={idx}
              onClick={() => respondToToolApproval(toolCall.id, true, opt)}
              className="px-3 py-1.5 rounded-lg bg-blue-600/30 hover:bg-blue-600/50 border border-blue-500/40 text-blue-200 text-xs transition-colors"
            >
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 pt-1">
          {alwaysState !== 'absent' && (
            <button
              type="button"
              onClick={alwaysState === 'available' ? () => respondToToolApproval(toolCall.id, true, '以后都允许') : undefined}
              disabled={alwaysState === 'locked'}
              title={alwaysState === 'locked' ? ALWAYS_ALLOW_LOCKED_TOOLTIP : undefined}
              aria-label={alwaysState === 'locked' ? ALWAYS_ALLOW_LOCKED_TOOLTIP : '以后都允许'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 text-amber-400 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:bg-amber-500/10 disabled:hover:bg-transparent"
            >
              <span>以后都允许</span>
            </button>
          )}
          <button
            onClick={() => respondToToolApproval(toolCall.id, true)}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors shadow-sm"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Approve & Continue</span>
          </button>
          <button
            onClick={() => respondToToolApproval(toolCall.id, false, 'User declined the action.')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/80 hover:text-white transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            <span>Decline</span>
          </button>
        </div>
      )}
    </div>
  )
}
