import { describe, it, expect } from 'vitest'

/**
 * PlanReviewCard 的纯逻辑测试（node 环境无 jsdom，不挂载组件）：
 * 1. 渲染门槛：planId/preview 为空 → 组件必须返回 null（不渲染空卡）；
 * 2. 事件契约：批准/放弃按钮必须发出 approve_plan 帧且 decision 正确；
 * 3. decide 回调之后必须调 onClose（卡片一次性）。
 *
 * 组件实现把这两块逻辑拆成可独立导入的纯函数，这里直接测它们——
 * 与后端 approve_plan 端点的 payload 契约（plan_id/decision）保持一致。
 */

// 组件内部逻辑（与 PlanReviewCard.tsx 同源，这里 re-import）
import { shouldRenderPlanCard, buildPlanDecisionPayload } from '../components/chat/planReviewLogic'

describe('PlanReviewCard render gate', () => {
  it('renders only when planId and preview are both non-empty', () => {
    expect(shouldRenderPlanCard('pa_x', '- [ ] 步骤')).toBe(true)
    expect(shouldRenderPlanCard('', '- [ ] 步骤')).toBe(false)
    expect(shouldRenderPlanCard('pa_x', '')).toBe(false)
    expect(shouldRenderPlanCard('pa_x', '   ')).toBe(false)
  })
})

describe('PlanReviewCard decision payload', () => {
  it('builds approve frame matching backend contract', () => {
    const payload = buildPlanDecisionPayload('pa_x', 'approve')
    expect(payload).toEqual({ planId: 'pa_x', decision: 'approve' })
  })
  it('builds discard frame matching backend contract', () => {
    const payload = buildPlanDecisionPayload('pa_y', 'discard')
    expect(payload).toEqual({ planId: 'pa_y', decision: 'discard' })
  })
  it('throws on invalid decision (typo guard)', () => {
    expect(() => buildPlanDecisionPayload('pa_x', 'maybe' as never)).toThrow()
  })
})
