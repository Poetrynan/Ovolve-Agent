export type Role = 'user' | 'assistant' | 'system'

export type ToolStatus = 'running' | 'done' | 'failed' | 'needs_input' | 'needs_confirmation'

export type ThoughtLevel = 'off' | 'low' | 'high' | 'max'

export interface ToolCall {
  id: string
  tool: string
  args: Record<string, any>
  output?: string
  status: ToolStatus
  startTime: number
  endTime?: number
  error?: string
  /**
   * 确认停点的场景语义（后端 guard 裁决经 WS tool_result meta 透传，
   * camelCase 对齐既有帧投影；旧后端 / 旧帧不带这些字段——消费方必须
   * 按"缺省 = 现状"处理，绝不可把 undefined 当 false 渲染）。
   */
  confirmReason?: string
  scenarioTags?: string[]
  confirmationClass?: string
  allowAlways?: boolean
  handoff?: boolean
}

export interface Message {
  id: string
  role: Role
  content: string
  reasoning?: string
  reasoningDuration?: number
  toolCalls?: ToolCall[]
  timestamp: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    total?: number
  }
  /**
   * 用量元数据（模型名、token 明细、费用）。可选：历史消息未必携带。
   * UsagePage 与 ContextTab 按此读取，形状与 llmService 侧使用的
   * MessageData.metadata 保持一致。
   */
  metadata?: {
    model?: string
    tokens?: number
    promptTokens?: number
    completionTokens?: number
    cachedTokens?: number
    cost?: number
    duration?: number
  }
}

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  model?: string
  thoughtLevel?: ThoughtLevel
  workspaceRoot?: string
  gitBranch?: string
}

export interface ModelConfig {
  provider: 'deepseek' | 'openai' | 'anthropic' | 'gemini' | 'siliconflow' | 'openrouter' | 'qwen' | 'ollama' | 'custom'
  apiKey: string
  baseUrl: string
  modelName: string
  temperature: number
  maxTokens: number
  systemPrompt: string
  thoughtLevel?: ThoughtLevel
}

export interface WorkspaceFolder {
  path: string
  name: string
  branch?: string
  status?: 'clean' | 'dirty'
}
