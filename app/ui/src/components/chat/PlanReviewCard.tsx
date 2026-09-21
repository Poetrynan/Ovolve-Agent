import { Check, X, FileText } from 'lucide-react'
import { shouldRenderPlanCard, buildPlanDecisionPayload, type PlanDecision } from './planReviewLogic'

interface Props {
  planId: string
  preview: string
  chars: number
  onSend: (type: string, payload?: Record<string, unknown>) => boolean
  onClose: () => void
}

/** Plan 模式方案审批卡：方案产物 ready 时出现，批准后自动进入执行轮。 */
export default function PlanReviewCard({ planId, preview, chars, onSend, onClose }: Props) {
  if (!shouldRenderPlanCard(planId, preview)) return null
  const decide = (decision: PlanDecision) => {
    onSend('approve_plan', buildPlanDecisionPayload(planId, decision))
    onClose()
  }
  return (
    <div className="mx-4 my-2 rounded-lg border border-border bg-card/60 backdrop-blur px-4 py-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
        <FileText size={13} />
        <span>方案已就绪（{chars} 字）· 批准后按方案分步执行</span>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[13px] leading-5 text-foreground/90 mb-3">{preview}</pre>
      <div className="flex items-center gap-2">
        <button
          onClick={() => decide('approve')}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary/90 hover:bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium"
        >
          <Check size={13} /> 批准执行
        </button>
        <button
          onClick={() => decide('discard')}
          className="inline-flex items-center gap-1.5 rounded-md border border-border hover:bg-muted px-3 py-1.5 text-xs text-muted-foreground"
        >
          <X size={13} /> 放弃
        </button>
      </div>
    </div>
  )
}
