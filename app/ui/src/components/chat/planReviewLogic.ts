/**
 * planReviewLogic.ts — PlanReviewCard 的纯逻辑（无 DOM 依赖，可单测）。
 * 事件契约与后端 http_server.approve_plan 分支一致：
 *   { planId, decision: 'approve' | 'discard' }
 */

export type PlanDecision = 'approve' | 'discard'

export function shouldRenderPlanCard(planId: string | undefined | null, preview: string | undefined | null): boolean {
  return Boolean(planId && preview && preview.trim())
}

export function buildPlanDecisionPayload(planId: string, decision: PlanDecision): { planId: string; decision: PlanDecision } {
  if (decision !== 'approve' && decision !== 'discard') {
    throw new Error(`invalid plan decision: ${decision}`)
  }
  if (!planId) {
    throw new Error('planId is required')
  }
  return { planId, decision }
}
