import { create } from 'zustand'
import type { Message, Session, ToolCall, ModelConfig, ToolStatus } from '../types/agent'

export interface QueuedPrompt {
  id: string
  content: string
  timestamp: number
}

// ── Live transport（liveBridge 注册的回程通道）────────────────────────────────
// 依赖倒置：store 不 import 桥（避免环），桥启动时注入、停止时清空。
// 未注册（无桥 / 测试 / 后端不在）时一切行为与既有演示驱动逐字节一致。

export interface LiveTransport {
  /** 桥当前是否在线（已连接后端 /ws）。 */
  isConnected: () => boolean
  /**
   * 把用户输入交给后端真实回合（user_prompt 帧）。
   * 未连接或发送失败返回 false——调用方回落演示驱动。
   */
  sendUserPrompt: (content: string) => boolean
  /**
   * 确认回程（respond_permission 帧）。桥侧过滤：仅对 live 卡片且在线时
   * 真正出帧——演示卡（本地 dispatchPrompt 生成的假 git:status）绝不外发。
   */
  sendApproval: (toolCallId: string, approved: boolean, feedback?: string) => void
}

let liveTransport: LiveTransport | null = null

/** liveBridge 启动时注册回程通道；停止时传 null 还原演示态。 */
export function setLiveTransport(transport: LiveTransport | null): void {
  liveTransport = transport
}

export function getLiveTransport(): LiveTransport | null {
  return liveTransport
}

/**
 * liveBridge 的 upsert 输入：id 是后端 wire 的 toolCallId（tool_call /
 * tool_result 帧共用同一个 id）。除 id/status 外全部可选——可选字段缺席
 * 表示"帧没带"，绝不覆盖卡片现状（旧帧不带 confirm 元数据时不抹掉旧值）。
 */
export interface LiveToolCallPatch {
  id: string
  tool?: string
  args?: Record<string, any>
  output?: string
  error?: string
  status: ToolStatus
  endTime?: number
  confirmReason?: string
  scenarioTags?: string[]
  confirmationClass?: string
  allowAlways?: boolean
  handoff?: boolean
}

interface AgentState {
  sessions: Session[]
  activeSessionId: string | null
  isStreaming: boolean
  isThinking: boolean
  currentThinking: string
  currentThinkingDuration: number
  streamingContent: string
  activeToolCalls: ToolCall[]
  modelConfig: ModelConfig
  theme: 'dark' | 'light'
  isSettingsOpen: boolean
  workspaceRoot: string | null
  queuedPrompts: QueuedPrompt[]

  // Actions
  setSessions: (sessions: Session[]) => void
  createSession: (title?: string) => string
  selectSession: (id: string) => void
  deleteSession: (id: string) => void
  updateActiveSessionTitle: (title: string) => void
  addMessage: (msg: Omit<Message, 'id' | 'timestamp'>) => void
  appendStreamingChunk: (chunk: string) => void
  appendThinkingChunk: (chunk: string) => void
  finalizeStreamingMessage: () => void
  addToolCall: (call: Omit<ToolCall, 'id' | 'startTime'>) => string
  updateToolCall: (id: string, update: Partial<ToolCall>) => void
  /**
   * 实时桥专用：以后端 toolCallId 为主键创建或更新工具调用卡片。
   * 缺席字段不覆盖现状；终态（done/failed）自动落 endTime（对齐
   * updateToolCall 的语义）。返回主键 id。
   */
  upsertLiveToolCall: (patch: LiveToolCallPatch) => string
  respondToToolApproval: (id: string, approved: boolean, feedback?: string) => void
  setModelConfig: (config: Partial<ModelConfig>) => void
  setTheme: (theme: 'dark' | 'light') => void
  toggleSettings: (open?: boolean) => void
  setWorkspaceRoot: (root: string | null) => void
  stopGeneration: () => void
  
  // Message Queue & Steer Actions
  enqueuePrompt: (content: string) => string
  removeQueuedPrompt: (id: string) => void
  steerImmediate: (id: string) => void
  dispatchPrompt: (content: string) => void
}

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: 'deepseek',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  modelName: 'deepseek-reasoner',
  temperature: 0.6,
  maxTokens: 8192,
  systemPrompt: 'You are OvolveAgent, a world-class autonomous AI coding and research partner.',
}

export const useAgentStore = create<AgentState>((set, get) => ({
  sessions: [
    {
      id: 'session-default',
      title: 'Welcome to OvolveAgent',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          id: 'm-welcome',
          role: 'assistant',
          content: 'Hello! I am **OvolveAgent**, your open-source autonomous desktop AI companion.\n\nHow can I help you build, code, explore, or automate today?',
          timestamp: Date.now(),
        },
      ],
    },
  ],
  activeSessionId: 'session-default',
  isStreaming: false,
  isThinking: false,
  currentThinking: '',
  currentThinkingDuration: 0,
  streamingContent: '',
  activeToolCalls: [],
  modelConfig: DEFAULT_MODEL_CONFIG,
  theme: 'dark',
  isSettingsOpen: false,
  workspaceRoot: null,
  queuedPrompts: [],

  setSessions: (sessions) => set({ sessions }),

  createSession: (title = 'New Exploration') => {
    const id = `session-${Date.now()}`
    const newSession: Session = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      workspaceRoot: get().workspaceRoot || undefined,
    }
    set((state) => ({
      sessions: [newSession, ...state.sessions],
      activeSessionId: id,
      streamingContent: '',
      currentThinking: '',
      activeToolCalls: [],
      queuedPrompts: [],
    }))
    return id
  },

  selectSession: (id) => set({ activeSessionId: id, streamingContent: '', currentThinking: '', queuedPrompts: [] }),

  deleteSession: (id) => {
    set((state) => {
      const remaining = state.sessions.filter((s) => s.id !== id)
      return {
        sessions: remaining,
        activeSessionId: state.activeSessionId === id ? (remaining[0]?.id ?? null) : state.activeSessionId,
      }
    })
  },

  updateActiveSessionTitle: (title) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === state.activeSessionId ? { ...s, title, updatedAt: Date.now() } : s
      ),
    }))
  },

  addMessage: (msg) => {
    const newMsg: Message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      ...msg,
    }
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === state.activeSessionId
          ? { ...s, messages: [...s.messages, newMsg], updatedAt: Date.now() }
          : s
      ),
    }))
  },

  appendStreamingChunk: (chunk) => {
    set((state) => ({
      isStreaming: true,
      streamingContent: state.streamingContent + chunk,
    }))
  },

  appendThinkingChunk: (chunk) => {
    set((state) => ({
      isThinking: true,
      currentThinking: state.currentThinking + chunk,
    }))
  },

  dispatchPrompt: (content: string) => {
    const state = get()
    state.addMessage({
      role: 'user',
      content,
    })

    // 真实帧优先：实时桥在线时把输入交给后端真实回合（tool_call /
    // tool_result 等真实帧驱动卡片），不跑下面的演示仿真；发送失败或
    // 无连接（后端未启动 / 测试环境）→ 维持演示驱动，逐字节不变。
    const transport = getLiveTransport()
    if (transport && transport.isConnected() && transport.sendUserPrompt(content)) return

    // Simulated Turn Execution with Thinking & Tools
    setTimeout(() => {
      state.appendThinkingChunk(`Analyzing prompt: "${content.slice(0, 40)}..."\nDecomposing goals and structuring verification pipeline...`)
    }, 150)

    setTimeout(() => {
      const toolId = state.addToolCall({
        tool: 'git:status',
        args: { cwd: '.' },
        status: 'running',
      })

      setTimeout(() => {
        state.updateToolCall(toolId, {
          status: 'done',
          output: 'On branch main\nYour branch is up to date with origin/main.\nnothing to commit, working tree clean',
        })
      }, 700)
    }, 900)

    setTimeout(() => {
      state.appendStreamingChunk(`Processed prompt: **${content}**.\n\nTask executed successfully via OvolveAgent execution runtime.`)
    }, 1800)

    setTimeout(() => {
      state.finalizeStreamingMessage()
    }, 2400)
  },

  finalizeStreamingMessage: () => {
    const state = get()
    if (state.streamingContent || state.currentThinking || state.activeToolCalls.length > 0) {
      state.addMessage({
        role: 'assistant',
        content: state.streamingContent,
        reasoning: state.currentThinking || undefined,
        reasoningDuration: state.currentThinkingDuration || undefined,
        toolCalls: state.activeToolCalls.length > 0 ? [...state.activeToolCalls] : undefined,
      })
    }

    set({
      isStreaming: false,
      isThinking: false,
      streamingContent: '',
      currentThinking: '',
      currentThinkingDuration: 0,
      activeToolCalls: [],
    })

    // Process next queued prompt automatically if any!
    const nextQueued = state.queuedPrompts[0]
    if (nextQueued) {
      set((s) => ({ queuedPrompts: s.queuedPrompts.slice(1) }))
      setTimeout(() => {
        get().dispatchPrompt(nextQueued.content)
      }, 200)
    }
  },

  enqueuePrompt: (content: string) => {
    const id = `queued-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const newQueued: QueuedPrompt = {
      id,
      content,
      timestamp: Date.now(),
    }
    set((state) => ({
      queuedPrompts: [...state.queuedPrompts, newQueued],
    }))
    return id
  },

  removeQueuedPrompt: (id: string) => {
    set((state) => ({
      queuedPrompts: state.queuedPrompts.filter((q) => q.id !== id),
    }))
  },

  steerImmediate: (id: string) => {
    const state = get()
    const target = state.queuedPrompts.find((q) => q.id === id)
    if (!target) return

    // 1. Remove from queue
    set((s) => ({ queuedPrompts: s.queuedPrompts.filter((q) => q.id !== id) }))

    // 2. Stop current generation immediately
    state.stopGeneration()

    // 3. Dispatch the steer prompt right away
    setTimeout(() => {
      get().dispatchPrompt(target.content)
    }, 150)
  },

  addToolCall: (call) => {
    const id = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const newCall: ToolCall = {
      id,
      startTime: Date.now(),
      ...call,
    }
    set((state) => ({
      activeToolCalls: [...state.activeToolCalls, newCall],
    }))
    return id
  },

  updateToolCall: (id, update) => {
    set((state) => ({
      activeToolCalls: state.activeToolCalls.map((tc) =>
        tc.id === id ? { ...tc, ...update, endTime: update.status === 'done' || update.status === 'failed' ? Date.now() : tc.endTime } : tc
      ),
    }))
  },

  upsertLiveToolCall: (patch) => {
    set((state) => {
      const existing = state.activeToolCalls.find((tc) => tc.id === patch.id)
      const merged: ToolCall = existing
        ? { ...existing }
        : { id: patch.id, tool: '', args: {}, status: 'running', startTime: Date.now() }
      // 缺省=现状：只有帧真正带来的字段才覆盖（confirm 元数据缺席时保留
      // 已有值，绝不让 undefined 抹掉）；id/startTime 恒不覆盖。
      if (patch.tool !== undefined) merged.tool = patch.tool
      if (patch.args !== undefined) merged.args = patch.args
      if (patch.output !== undefined) merged.output = patch.output
      if (patch.error !== undefined) merged.error = patch.error
      if (patch.endTime !== undefined) merged.endTime = patch.endTime
      if (patch.confirmReason !== undefined) merged.confirmReason = patch.confirmReason
      if (patch.scenarioTags !== undefined) merged.scenarioTags = patch.scenarioTags
      if (patch.confirmationClass !== undefined) merged.confirmationClass = patch.confirmationClass
      if (patch.allowAlways !== undefined) merged.allowAlways = patch.allowAlways
      if (patch.handoff !== undefined) merged.handoff = patch.handoff
      merged.status = patch.status
      // 终态落 endTime：对齐 updateToolCall 的既有语义。
      if (merged.endTime === undefined && (merged.status === 'done' || merged.status === 'failed')) {
        merged.endTime = Date.now()
      }
      return {
        activeToolCalls: existing
          ? state.activeToolCalls.map((tc) => (tc.id === patch.id ? merged : tc))
          : [...state.activeToolCalls, merged],
      }
    })
    return patch.id
  },

  respondToToolApproval: (id, approved, feedback) => {
    set((state) => ({
      activeToolCalls: state.activeToolCalls.map((tc) =>
        tc.id === id
          ? {
              ...tc,
              status: approved ? 'done' : 'failed',
              output: approved ? (tc.output || 'Approved by user') : `Rejected: ${feedback || 'Action cancelled by user'}`,
              endTime: Date.now(),
            }
          : tc
      ),
    }))
    // 确认回程：真实会话中把批准/拒绝送回后端（respond_permission 帧，
    // approve / approve_always / deny 的映射在桥侧）。桥不在线或卡片不是
    // live 来源时桥会静默忽略——演示路径零变化。
    liveTransport?.sendApproval(id, approved, feedback)
  },

  setModelConfig: (config) => set((state) => ({ modelConfig: { ...state.modelConfig, ...config } })),

  setTheme: (theme) => {
    set({ theme })
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
      document.documentElement.classList.remove('light')
    } else {
      document.documentElement.classList.add('light')
      document.documentElement.classList.remove('dark')
    }
  },

  toggleSettings: (open) => set((state) => ({ isSettingsOpen: open ?? !state.isSettingsOpen })),

  setWorkspaceRoot: (root) => set({ workspaceRoot: root }),

  stopGeneration: () => {
    const state = get()
    if (state.isStreaming || state.isThinking) {
      state.finalizeStreamingMessage()
    }
  },
}))
