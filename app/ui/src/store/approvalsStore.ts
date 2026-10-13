/**
 * approvalsStore — 演化裁决页投影的前端镜像。
 *
 * 后端 `approvals_projection.pending_approvals()` 把两类"自进化环在等人工拍板"
 * 的事项聚合成一份只读投影：staged 状态的技能候选 + pending 演化提案。
 * ask_user 问题卡不在投影里——它是会话进行中的临时交互，归属聊天流（产品
 * 决定，2026-08）；这里因此也不再有 questions 字段。
 *
 * 轮询（30s）在应用启动时开始、全局只跑一份；动作（批准/拒绝/回滚）
 * 之后由页面显式 `fetchApprovals()` 立即刷新，不等下一轮。
 * 不做持久化：这是后端真相的投影，一份过期的 localStorage 副本比没有更糟。
 */
import { create } from 'zustand'
import { fetchJson, API_BASE } from '@lib/api'

export interface ApprovalSkillCandidate {
  id: string
  name: string
  version?: string
  status?: string
  description?: string
  // 条目形状不统一：门禁判定是 {ok, detail}，verification_run 是执行记录
  // （ran / machineVerified / confinement …）。用 unknown + readGate 读，
  // 否则"没有 ok 字段"会被渲染成一个红叉，谎报门禁失败。
  gate_report?: Record<string, unknown>
}

export interface ApprovalEvolutionProposal {
  id: string
  kind: string
  // 后端 Proposal.to_dict() 吐的是 camelCase
  targetFile?: string
  toolName?: string
  draft?: string
  rationale?: string
  hits?: number
  status?: string
  createdAt?: number
  /** 非空 = 批准即替换这一行（冲突裁决），而不是追加一条新规则。 */
  supersedes?: string
  userTitle?: string
  userAdvice?: string
  userReason?: string
  category?: string
}


export interface ApprovalsSnapshot {
  skillCandidates: ApprovalSkillCandidate[]
  evolutionProposals: ApprovalEvolutionProposal[]
  counts: {
    skillCandidates: number
    evolutionProposals: number
    total: number
  }
}

const EMPTY: ApprovalsSnapshot = {
  skillCandidates: [],
  evolutionProposals: [],
  counts: { skillCandidates: 0, evolutionProposals: 0, total: 0 },
}

/** 30s 足够"新问题出现后半分钟内被看到"，又不至于把后端当心跳靶子。 */
const POLL_INTERVAL_MS = 30_000

interface ApprovalsState {
  data: ApprovalsSnapshot
  loaded: boolean
  error: string
  fetchApprovals: () => Promise<void>
}

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  data: EMPTY,
  loaded: false,
  error: '',
  fetchApprovals: async () => {
    try {
      const snap = await fetchJson<ApprovalsSnapshot>(
        `${API_BASE}/api/approvals/pending`)
      set({
        // 后端契约就是聚合响应；字段缺失时退回空快照而不是 undefined 链
        data: {
          skillCandidates: Array.isArray(snap?.skillCandidates) ? snap.skillCandidates : [],
          evolutionProposals: Array.isArray(snap?.evolutionProposals) ? snap.evolutionProposals : [],
          counts: snap?.counts ?? EMPTY.counts,
        },
        loaded: true,
        error: '',
      })
    } catch (e) {
      // 保留旧数据——一次网络抖动不该清空用户正看着的列表
      set({ loaded: true, error: e instanceof Error ? e.message : String(e) })
    }
  },
}))

let pollTimer: ReturnType<typeof setInterval> | null = null

/** 应用启动时调用一次：立即拉取并开始 30s 轮询。幂等。 */
export function startApprovalsPolling(): void {
  if (pollTimer) return
  void useApprovalsStore.getState().fetchApprovals()
  pollTimer = setInterval(() => {
    void useApprovalsStore.getState().fetchApprovals()
  }, POLL_INTERVAL_MS)
}
