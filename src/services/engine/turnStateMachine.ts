import { PersistentTerminalManager } from '../tools/persistentTerminal'

export type TurnState =
  | 'IDLE'              // 空闲待命
  | 'PLANNING'          // 任务准入与角色动态转向
  | 'THINKING'          // 正在输出思考流 (<think>)
  | 'EXECUTING_TOOL'    // 正在执行工具 (终端命令/文件操作)
  | 'INTERRUPTING'      // 收到抢占打断指令，正在杀死子进程并保存上下文
  | 'INTERRUPTED'       // 打断已完成，上半场数据已封存
  | 'FINALIZING'        // 正常收尾与记忆提取
  | 'ERROR'             // 异常故障

export type TurnEvent =
  | { type: 'START_TURN'; prompt: string; sessionId: string }
  | { type: 'THINK_CHUNK'; chunk: string }
  | { type: 'TOOL_START'; toolName: string; args: Record<string, any> }
  | { type: 'TOOL_DONE'; output: string; exitCode?: number }
  | { type: 'STEER_INTERRUPT'; steerPrompt: string; reason?: string }
  | { type: 'FINALIZE' }
  | { type: 'ERROR'; error: string }
  | { type: 'RESET' }

export interface TurnContext {
  turnId: string
  sessionId: string
  originalPrompt: string
  currentState: TurnState
  activeToolName?: string
  activeToolArgs?: Record<string, any>
  accumulatedThinking: string
  accumulatedContent: string
  isInterrupted: boolean
  steerPrompt?: string
  abortController: AbortController | null
}

export type StateChangeCallback = (state: TurnState, context: TurnContext) => void

export class TurnStateMachine {
  private context: TurnContext
  private listeners: StateChangeCallback[] = []

  constructor(sessionId = 'default') {
    this.context = {
      turnId: `turn-${Date.now()}`,
      sessionId,
      originalPrompt: '',
      currentState: 'IDLE',
      accumulatedThinking: '',
      accumulatedContent: '',
      isInterrupted: false,
      abortController: null,
    }
  }

  public getState(): TurnState {
    return this.context.currentState
  }

  public getContext(): Readonly<TurnContext> {
    return { ...this.context }
  }

  public onStateChange(cb: StateChangeCallback): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }

  private transition(nextState: TurnState): void {
    const prevState = this.context.currentState
    this.context.currentState = nextState
    this.listeners.forEach((cb) => cb(nextState, this.context))
  }

  /**
   * Main state machine dispatch loop
   */
  public async dispatch(event: TurnEvent): Promise<TurnState> {
    const current = this.context.currentState

    switch (event.type) {
      case 'START_TURN': {
        this.context.turnId = `turn-${Date.now()}`
        this.context.sessionId = event.sessionId
        this.context.originalPrompt = event.prompt
        this.context.accumulatedThinking = ''
        this.context.accumulatedContent = ''
        this.context.isInterrupted = false
        this.context.steerPrompt = undefined
        this.context.abortController = new AbortController()

        this.transition('PLANNING')
        return this.context.currentState
      }

      case 'THINK_CHUNK': {
        if (current === 'PLANNING' || current === 'THINKING') {
          this.context.accumulatedThinking += event.chunk
          if (current !== 'THINKING') {
            this.transition('THINKING')
          }
        }
        return this.context.currentState
      }

      case 'TOOL_START': {
        this.context.activeToolName = event.toolName
        this.context.activeToolArgs = event.args
        this.transition('EXECUTING_TOOL')
        return this.context.currentState
      }

      case 'TOOL_DONE': {
        this.context.activeToolName = undefined
        this.context.activeToolArgs = undefined
        if (current === 'EXECUTING_TOOL') {
          this.transition('THINKING')
        }
        return this.context.currentState
      }

      case 'STEER_INTERRUPT': {
        // 抢占打断核心逻辑：
        // 1. 状态跃迁至 INTERRUPTING
        this.transition('INTERRUPTING')
        this.context.isInterrupted = true
        this.context.steerPrompt = event.steerPrompt

        // 2. 触发 AbortController 信号，打断 LLM 流式网络连接
        if (this.context.abortController && !this.context.abortController.signal.aborted) {
          this.context.abortController.abort()
        }

        // 3. 如果正在运行持久化终端进程，立即调用 cancelCurrentCommand 杀死子进程树
        if (current === 'EXECUTING_TOOL') {
          try {
            const terminal = PersistentTerminalManager.getInstance().getSession(this.context.sessionId)
            terminal.closeShell() // 强制重置终端，杀掉挂起的长耗时进程
          } catch {}
        }

        // 4. 封存上半场输出并跃迁至 INTERRUPTED
        this.transition('INTERRUPTED')
        return this.context.currentState
      }

      case 'FINALIZE': {
        this.transition('FINALIZING')
        this.transition('IDLE')
        return this.context.currentState
      }

      case 'ERROR': {
        this.transition('ERROR')
        return this.context.currentState
      }

      case 'RESET': {
        this.transition('IDLE')
        return this.context.currentState
      }

      default:
        return this.context.currentState
    }
  }
}
