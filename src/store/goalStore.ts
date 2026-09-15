// src/store/goalStore.ts
// 自主目标的渲染层状态（zustand）。Ovolve 此前 src/ 没有 goal store
// （GoalsPage 仅 localStorage 自娱），本 store 是最小自洽实现：
//   · fetchGoals —— GET /api/goals，经 goalNormalize 归一（数值字段全部
//     有界，杜绝 undefined 越界渲染）。
//   · applyStateChange —— 把 goal_state_change WS 事件合并进本地状态。
//     阶段新鲜度规则：stage 只与最近一条声明了它的事件同样新鲜，不带的
//     事件（终态 / 新一轮首帧）把它清空为 null，绝不让上一轮的阶段
//     泄漏进这一次运行。
//   · U5 接管与佐证：handoff_required 严格 ===true 置真、其余事件覆写
//     清除；deliveryHints 粘性（?? 保留已收集，早于该字段的事件不得抹掉）。
//   · connectGoalEvents —— 把 goal_state_change 消费者注册进实时桥
//     （src/lib/liveBridge.ts，单例 WS + 指数退避重连）并确保桥启动。
//     本 store 不再自持 WebSocket：一个连接、多消费者（tool 帧 →
//     agentStore、goal 帧 → 本 store），杜绝双连接双退避。
import { create } from 'zustand'
import type { Goal } from '../types/goal'
import { API_BASE, apiFetch } from '../lib/api'
import { normalizeGoal, stageFromWire, deliveryHintsFromWire } from '../lib/goalNormalize'
import { registerFrameConsumer, startLiveBridge } from '../lib/liveBridge'

interface GoalState {
  goals: Goal[]
  loading: boolean
  /** 最近一次后端错误，落到 UI 上而不是静默失败。 */
  error: string | null

  fetchGoals: () => Promise<void>
  /** 合并一条 goal_state_change WS 事件到本地状态。 */
  applyStateChange: (goalId: string, status: string, extra?: Record<string, any>) => void
  clearError: () => void
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    return body?.error || fallback
  } catch {
    return fallback + ' (HTTP ' + res.status + ')'
  }
}

export const useGoalStore = create<GoalState>((set, get) => ({
  goals: [],
  loading: false,
  error: null,

  clearError: () => set({ error: null }),

  fetchGoals: async () => {
    set({ loading: true })
    try {
      const res = await apiFetch(API_BASE + '/api/goals')
      if (!res.ok) {
        set({ error: await readError(res, '加载目标失败'), loading: false })
        return
      }
      const data = await res.json()
      const list = Array.isArray(data) ? data : (Array.isArray(data?.goals) ? data.goals : [])
      set({ goals: list.map(normalizeGoal), loading: false, error: null })
    } catch (e: any) {
      set({ error: e?.message || '网络错误', loading: false })
    }
  },

  applyStateChange: (goalId, status, extra = {}) => {
    const known = get().goals.some(g => g.id === goalId)
    if (!known) {
      // 没见过的目标在别处（bot / cron / 首连前的运行）发生了变化：重拉全量，
      // 而不是在本地捏一条缺字段的半行。
      void get().fetchGoals()
      return
    }
    set(state => ({
      goals: state.goals.map(g =>
        g.id === goalId
          ? {
              ...g,
              status: status as Goal['status'],
              iteration: typeof extra.iteration === 'number' ? extra.iteration : g.iteration,
              maxIterations:
                typeof extra.max_iterations === 'number' ? extra.max_iterations : g.maxIterations,
              // 这里的上限一定来自后端，是唯一允许把标志翻真的位置。
              maxIterationsKnown:
                typeof extra.max_iterations === 'number' && extra.max_iterations > 0
                  ? true
                  : g.maxIterationsKnown,
              lastError: typeof extra.error === 'string' ? extra.error
                : typeof extra.reason === 'string' ? extra.reason
                : g.lastError,
              // 细粒度阶段（stageFromWire 只放行 plan/execute/verify）。
              stage: stageFromWire(extra.stage),
              // U5 人接管信号：严格 ===true 才置真，其余事件（阶段推进 /
              // 完成 / 失败 / 不带字段的新一轮首帧）一律覆写清除——横幅只
              // 反映最新事件的事实，绝不残留旧警觉。
              handoffRequired: extra.handoff_required === true,
              handoffDetail:
                extra.handoff_required === true
                  ? String(extra.handoff_detail ?? '')
                  : '',
              // U5 佐证聚合：粘性字段（?? 语义）——事件不带 delivery_hints
              // 时保留已收集值，早于该字段存在的事件不得把它抹掉；带了的
              // 事件以后端的全量累计为准（后端自身跨轮 merge）。
              deliveryHints: deliveryHintsFromWire(extra.delivery_hints) ?? g.deliveryHints,
            }
          : g,
      ),
    }))
  },
}))

// ---------------------------------------------------------------------------
// goal_state_change 消费者（并入实时桥后的形态）。
// 封套口径：{ type: 'goal_state_change', payload: { goal_id, status, ... } }；
// 对扁平载荷（无 payload 包装）同样放行，宁可多兼容一层也不漏事件。
// ---------------------------------------------------------------------------

/**
 * 实时桥的帧入口：接受桥解析好的封套对象（也容忍原始 JSON 串——
 * 与旧 handleEnvelope 等宽）。非 goal_state_change 帧在此无操作。
 */
export function consumeGoalFrame(raw: unknown): void {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
  }
  if (!data || typeof data !== 'object') return
  const envelope = data as Record<string, any>
  const type = envelope.type ?? envelope.event
  if (type !== 'goal_state_change') return
  const payload = (envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : envelope) as Record<string, any>
  const goalId = payload.goal_id ?? payload.goalId
  if (!goalId) return
  useGoalStore.getState().applyStateChange(
    String(goalId),
    String(payload.status ?? 'running'),
    payload,
  )
}

let unregisterGoalConsumer: (() => void) | null = null

/**
 * 订阅 goal_state_change（并入实时桥）：注册消费者 + 幂等启动桥。
 * 重复调用先退订再重挂——桥被 stop/start 重建后调用方自愈。
 */
export function connectGoalEvents(): void {
  unregisterGoalConsumer?.()
  unregisterGoalConsumer = registerFrameConsumer('goal_state_change', consumeGoalFrame)
  startLiveBridge()
}

/** 取消订阅（页面卸载时调用；共享连接的生命周期归桥/根组件管）。 */
export function disconnectGoalEvents(): void {
  unregisterGoalConsumer?.()
  unregisterGoalConsumer = null
}
