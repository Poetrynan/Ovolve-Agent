// src/types/goal.ts
// 自主目标（goal_scheduler）的 wire 类型。字段口径与后端 /api/goals 行 +
// goal_state_change WS 载荷对齐：REST 行不带 stage，细粒度阶段只经 WS 事件
// 落到 Goal.stage（goalNormalize.stageFromWire 校验）。

export interface GoalSubtask {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}

export type GoalStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopping'
  | 'stop_timeout'
  | string

/**
 * goal_state_change 事件携带的交付语义聚合（U5 佐证）。后端跨轮累计，
 * 前端只透传渲染；字段口径与 goal_scheduler.empty_delivery_hints 一致。
 */
export interface GoalDeliveryHints {
  /** 动作结果确实命中声明目标的次数（屏幕证据佐证）。 */
  deliverableCount: number
  /** 结果应移交人处理的次数。 */
  handoffCount: number
  /** 最新一条移交说明原文。 */
  latestHandoffDetail: string
}

export interface Goal {
  id: string
  description: string
  status: GoalStatus
  /** 已消耗的续跑轮次。 */
  iteration: number
  /** 续跑轮次硬上限（熔断器）。 */
  maxIterations: number
  /**
   * false 表示 maxIterations 是前端兜底默认值而非后端实发——渲染"第 n/max 轮"
   * 之类分母前必须检查此标志，不虚构预算。
   */
  maxIterationsKnown: boolean
  subtasksCompleted: number
  subtasksTotal: number
  /** 没有计划可数时为 null（UI 渲染标签而不是比例条）。 */
  progressRatio: number | null
  plan: GoalSubtask[]
  costUsd: number
  costCapUsd: number
  tokensUsed: number
  /** 上次停止原因；干净停止时为空串。 */
  lastError: string
  verification: { passed: boolean; reason: string; suggestions: string[] } | null
  /**
   * 最近一条 goal_state_change WS 事件携带的细粒度流水线阶段。
   * 事件不带 stage 时为 null——UI 回落按 status 推导，绝不猜。
   */
  stage?: 'plan' | 'execute' | 'verify' | null
  /**
   * 人接管信号（U5）：goal_scheduler 在 handoff 计数上升时发出的
   * handoff_required=true 事件。严格 ===true 才算需要接管；任何不携带
   * 该字段（或非 true）的事件都把标志清回 false——横幅只反映最新事实。
   */
  handoffRequired: boolean
  /** 最近一次接管事件的 detail（后端 delivery_hints.latest_handoff_detail）。 */
  handoffDetail: string
  /**
   * 交付语义聚合。粘性字段：事件不带 delivery_hints 时保留已收集值
   * （?? 语义）——早于该字段存在的事件不得把它抹掉。
   */
  deliveryHints: GoalDeliveryHints | null
  sessionId: string
  createdAt: number
  updatedAt: number
  startedAt: number
}
