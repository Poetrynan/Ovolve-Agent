// 细粒度 stage 事件
// 已由 P1-4 接线（goal_scheduler.py 在阶段切换点补发）。
// src/lib/goalStages.ts
// 目标流水线阶段模型（P1-4 子项二）。
//
// 后端事实（P1-4 接线后）：
//   · goal_scheduler 通过 event bus 推 `goal_state_change`，载荷字段：
//     goal_id / status / iteration / max_iterations，completed 时额外带
//     verified + verifySummary。
//   · P1-4 起阶段切换（plan→execute→verify）在同一通道上补发细粒度
//     `stage` 字段（worker 循环的规划/执行/验证三处），载荷另带 ts 时间戳；
//     终态与普通状态事件不带 stage。
//   · 规划产物 = goal_plan（plan 子任务列表，随 /api/goals 下发）。
//
// 本模块的口径：优先消费真实 `stage`（stageViewFromEvent 直接点亮对应阶段）；
// 事件不带 stage 时用 status/iteration 诚实推导（排队 / 执行轮次 / 验证门 /
// 终态），绝不虚构当前阶段。
// mock 路径：createMockStageEventStream 提供演示/单测用的阶段事件序列。

import type { Goal } from '../types/goal'

export type GoalStageId = 'queued' | 'plan' | 'execute' | 'verify' | 'done'

/** 后端 P1-4 起真实下发的细粒度阶段值（`goal_state_change` 的 `stage` 字段）。 */
export type GoalStageEventPhase = 'plan' | 'execute' | 'verify'

export interface GoalStage {
  id: GoalStageId
  label: string
  state: 'done' | 'active' | 'pending' | 'failed'
}

export interface GoalStageView {
  stages: GoalStage[]
  /** 阶段条右侧的补充说明（轮次 / 暂停 / 失败原因摘要）。 */
  note?: string
  /** 目标是否处于活动执行期（决定条上是否转菊花）。 */
  running: boolean
}

export const GOAL_STAGE_LABELS: Record<GoalStageId, string> = {
  queued: '排队',
  plan: '规划',
  execute: '执行',
  verify: '验证',
  done: '完成',
}

const STAGE_ORDER: GoalStageId[] = ['queued', 'plan', 'execute', 'verify', 'done']

const RUNNING_INPUT = new Set(['running', 'active', 'started'])

function view(
  states: Partial<Record<GoalStageId, GoalStage['state']>>,
  opts: { note?: string; running?: boolean } = {},
): GoalStageView {
  return {
    stages: STAGE_ORDER.map((id) => ({
      id,
      label: GOAL_STAGE_LABELS[id],
      state: states[id] ?? 'pending',
    })),
    note: opts.note,
    running: opts.running ?? false,
  }
}

/**
 * 从一次 `goal_state_change` 事件载荷推导阶段视图（不依赖 Goal 完整对象，
 * WS 事件直接可用）。`stage` 字段由后端 P1-4 起在阶段切换点真实下发；
 * 不带的载荷（终态 / 普通状态事件）按 status 诚实推导。
 */
export function stageViewFromEvent(evt: {
  status?: string
  stage?: string
  iteration?: number
  max_iterations?: number
  verified?: boolean
  error?: string
  /** P1-4 起阶段事件附带的秒级时间戳；本模块不消费，只放行不拒收。 */
  ts?: number
}): GoalStageView {
  const status = String(evt.status || '').toLowerCase()
  const phase = evt.stage as GoalStageEventPhase | undefined
  const it = typeof evt.iteration === 'number' && evt.iteration > 0 ? evt.iteration : 0
  const max = typeof evt.max_iterations === 'number' && evt.max_iterations > 0 ? evt.max_iterations : 0
  const roundNote = it > 0 ? (max > 0 ? `第 ${it}/${max} 轮` : `第 ${it} 轮`) : undefined

  if (status === 'queued') return view({ queued: 'active' }, { running: true })
  if (status === 'completed') {
    return view(
      { queued: 'done', plan: 'done', execute: 'done', verify: 'done', done: 'done' },
      { note: '机器验证通过' },
    )
  }
  if (status === 'failed' || status === 'ovolve_failed_final') {
    return view(
      { queued: 'done', plan: 'done', execute: 'failed' },
      { note: evt.error || '执行失败' },
    )
  }
  if (status === 'paused') {
    return view(
      { queued: 'done', plan: 'done', execute: 'active' },
      { note: roundNote ? `${roundNote} · 已暂停` : '已暂停' },
    )
  }
  if (RUNNING_INPUT.has(status)) {
    // 细粒度阶段（P1-4 已接线）：plan / verify 由真实事件直接点亮。
    if (phase === 'plan') return view({ queued: 'done', plan: 'active' }, { note: roundNote, running: true })
    if (phase === 'verify') return view({ queued: 'done', plan: 'done', execute: 'done', verify: 'active' }, { note: roundNote, running: true })
    return view(
      { queued: 'done', plan: 'done', execute: 'active' },
      { note: roundNote ?? '正在执行', running: true },
    )
  }
  // stopping / stop_timeout / 未知状态：保守地显示执行中断。
  if (status) {
    return view(
      { queued: 'done', plan: 'done', execute: 'active' },
      { note: status === 'stopping' ? '正在停止…' : `状态：${status}` },
    )
  }
  return view({})
}

/**
 * 从 store 里的 Goal（已被 goalNormalize 归一）推导阶段视图。
 * 这是目标卡（GoalsPage Row 2.5）的数据入口。`goal.stage` 是 P1-4 真实
 * 阶段事件经 goalStore 落下的最新值（不带 stage 的事件会把它清空）。
 */
export function deriveGoalStages(goal: Goal): GoalStageView {
  const base = stageViewFromEvent({
    status: goal.status,
    stage: goal.stage ?? undefined,
    iteration: goal.iteration,
    max_iterations: goal.maxIterationsKnown ? goal.maxIterations : undefined,
    error: goal.lastError || undefined,
  })
  // 已有验证结论（上一次门禁）时，把"验证"阶段如实标注：通过=done，
  // 未通过=失败而不是装作没跑过。
  if (goal.verification && goal.status !== 'completed') {
    const verifyStage = base.stages.find((s) => s.id === 'verify')
    if (verifyStage) {
      verifyStage.state = goal.verification.passed ? 'done' : 'failed'
      if (!goal.verification.passed && !base.note) base.note = '验证未通过'
    }
  }
  return base
}

export interface MockStageEvent {
  at: number
  payload: Parameters<typeof stageViewFromEvent>[0]
}

/**
 * mock 数据路径：一段演示用的阶段事件序列（排队→规划→执行×3→验证→完成）。
 * 用途：单元测试锁定 stageViewFromEvent 的全状态机 + 视觉演示。
 * **不是生产数据源**——生产事件由 goal_scheduler 真实下发。
 */
export function createMockStageEventStream(): MockStageEvent[] {
  return [
    { at: 0, payload: { status: 'queued' } },
    { at: 1, payload: { status: 'running', stage: 'plan' } },
    { at: 2, payload: { status: 'running', iteration: 1, max_iterations: 5 } },
    { at: 3, payload: { status: 'running', iteration: 2, max_iterations: 5 } },
    { at: 4, payload: { status: 'running', iteration: 3, max_iterations: 5, stage: 'verify' } },
    { at: 5, payload: { status: 'completed', iteration: 3, verified: true } },
  ]
}

/** 把 mock/真实事件流折叠成最终阶段视图（reduce 便利函数）。 */
export function foldStageEvents(events: MockStageEvent[]): GoalStageView {
  let acc = view({})
  for (const e of events) acc = stageViewFromEvent(e.payload)
  return acc
}
