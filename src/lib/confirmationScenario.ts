// src/lib/confirmationScenario.ts
// 确认卡场景化的决策纯函数层：后端 guard 裁决（confirmReason / scenarioTags /
// confirmationClass / allowAlways / handoff）→ 卡片该渲染什么。全部纯函数、
// 零 React 依赖，node 环境可直接单测；组件只消费结论，不内嵌判断。
//
// 零回归纪律：旧帧 / 旧后端不带新字段（undefined）——每个函数对缺省的裁决
// 都必须与"字段不存在时的现状"逐字节一致。
import type { ToolCall } from '../types/agent'

/** 场景标签 → 中文 chip。未知标签跳过（不猜、不兜底成原文）。 */
export const SCENARIO_CHIP_LABELS: Record<string, string> = {
  deletion: '删除',
  credential: '凭据',
  finance: '支付',
  third_party_comm: '对外发送',
  system_security: '系统安全',
  captcha: '验证码',
  software_install: '安装',
  sensitive_transmission: '敏感外传',
  medical: '医疗',
}

/**
 * 场景中文 chip 列表。按后端给的顺序渲染（后端已是 SCENARIO_TAGS 固定序）；
 * 未识别的标签直接跳过，空/缺省返回空数组（调用方据此不渲染 chip 行）。
 */
export function scenarioChips(tags?: string[] | null): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  for (const t of tags) {
    const label = typeof t === 'string' ? SCENARIO_CHIP_LABELS[t] : undefined
    if (label && !out.includes(label)) out.push(label)
  }
  return out
}

/** "以后都允许"按钮的三态：absent = 不渲染（现状），locked = 置灰，available = 可用。 */
export type AlwaysAllowState = 'absent' | 'available' | 'locked'

export function alwaysAllowState(tc: Pick<ToolCall, 'allowAlways'>): AlwaysAllowState {
  if (tc.allowAlways === undefined || tc.allowAlways === null) return 'absent'
  return tc.allowAlways === false ? 'locked' : 'available'
}

/** 必弹场景置灰的说明（title tooltip / aria-label 共用）。 */
export const ALWAYS_ALLOW_LOCKED_TOOLTIP = '删除/支付/验证码类操作每次都要确认'

/**
 * 键盘 Enter 是否批准。handoff 接管卡没有任何可批准的选项——Enter 必须跳过
 * （现状卡无 handoff 字段 → 与今天一致，Enter 照常批准）。
 */
export function enterApproves(tc: Pick<ToolCall, 'handoff'>): boolean {
  return tc.handoff !== true
}

/** 是否渲染接管提示卡（handoff 严格 === true 才算——null/undefined 都不算）。 */
export function isTakeover(tc: Pick<ToolCall, 'handoff'>): boolean {
  return tc.handoff === true
}

/** 卡片形态：takeover 接管卡 / approval 审批卡 / plain 普通卡片。 */
export type ConfirmCardMode = 'takeover' | 'approval' | 'plain'

const ATTENTION_STATUSES = ['needs_confirmation', 'needs_input', 'failed'] as const

/**
 * ActivityFeed 的分流：handoff 卡优先于一切（含 failed——后端把移交动作停成
 * denied，落到前端就是 failed 状态的卡，但它必须以接管卡呈现而不是红色失败卡）；
 * 其余 needs_confirmation / needs_input 走审批卡；其他状态维持普通卡片。
 */
export function confirmCardMode(tc: Pick<ToolCall, 'status' | 'handoff'>): ConfirmCardMode {
  if (tc.handoff === true && (ATTENTION_STATUSES as readonly string[]).includes(tc.status)) {
    return 'takeover'
  }
  if (tc.status === 'needs_confirmation' || tc.status === 'needs_input') return 'approval'
  return 'plain'
}

/** 拦截原因行文案：非空原文才显示，空白串视同缺省。 */
export function confirmReasonText(tc: Pick<ToolCall, 'confirmReason'>): string | null {
  const r = typeof tc.confirmReason === 'string' ? tc.confirmReason.trim() : ''
  return r.length > 0 ? r : null
}
