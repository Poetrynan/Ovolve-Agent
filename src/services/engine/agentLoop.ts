import { MemoryFacade } from '../memory/memoryFacade'
import { GepaEvolutionEngine } from './gepaEvolution'
import { RepeatToolGuard } from '../tools/repeatToolGuard'
import { getSpillManager } from '../tools/toolOutputSpill'
import { PersistentTerminalManager } from '../tools/persistentTerminal'
import { replaceFileContent, viewFile, writeToFile } from '../tools/fileTools'
import { TurnStateMachine } from './turnStateMachine'
import type { ModelConfig, ToolCall } from '../../types/agent'

export interface TurnHooks {
  onThinkingChunk?: (chunk: string) => void
  onTextChunk?: (chunk: string) => void
  onToolCallStart?: (toolCall: Omit<ToolCall, 'startTime'>) => void
  onToolCallEnd?: (id: string, output: string, error?: string) => void
}

export class AgentLoopEngine {
  private memory = MemoryFacade.getInstance()
  private evolution = GepaEvolutionEngine.getInstance()
  private toolGuard = new RepeatToolGuard()
  private spill = getSpillManager()
  private terminal = PersistentTerminalManager.getInstance()
  private stateMachine: TurnStateMachine

  constructor(sessionId = 'default') {
    this.stateMachine = new TurnStateMachine(sessionId)
  }

  public getStateMachine(): TurnStateMachine {
    return this.stateMachine
  }

  public async executeTool(
    id: string,
    toolName: string,
    args: Record<string, any>,
    sessionId = 'default',
    workspaceRoot = '.'
  ): Promise<{ output: string; error?: string }> {
    // 1. Check Repeat Loop Guard
    this.toolGuard.recordCall(toolName, args)
    const loopAlert = this.toolGuard.checkLoop()
    if (loopAlert) {
      // Record failure signature into GEPA evolution
      this.evolution.recordFailureSignature(loopAlert.failureSignature, loopAlert.advisoryMessage)
      return {
        output: loopAlert.advisoryMessage,
        error: 'RepeatLoopDetected',
      }
    }

    try {
      let rawResult = ''

      if (toolName === 'run_command' || toolName === 'terminal') {
        const cmd = args.CommandLine || args.command || ''
        const shell = this.terminal.getSession(sessionId, workspaceRoot)
        const res = await shell.execute(cmd)
        rawResult = res.output + (res.error ? `\n[Error]: ${res.error}` : '')
      } else if (toolName === 'replace_file_content') {
        const res = replaceFileContent({
          targetFile: args.TargetFile || args.targetFile || '',
          targetContent: args.TargetContent || args.targetContent || '',
          replacementContent: args.ReplacementContent || args.replacementContent || '',
          allowMultiple: args.AllowMultiple || args.allowMultiple || false,
        })
        rawResult = res.ok ? `Successfully replaced content in ${args.TargetFile}` : `Error: ${res.error}`
      } else if (toolName === 'view_file') {
        const res = viewFile(args.AbsolutePath || args.filePath || '', args.StartLine, args.EndLine)
        rawResult = res.ok ? (res.content || '') : `Error: ${res.error}`
      } else if (toolName === 'write_to_file') {
        const res = writeToFile(args.TargetFile || args.filePath || '', args.CodeContent || args.content || '')
        rawResult = res.ok ? `Successfully wrote to ${args.TargetFile}` : `Error: ${res.error}`
      } else {
        rawResult = `Tool ${toolName} executed with args: ${JSON.stringify(args)}`
      }

      // 2. Process Output Spill (Head-Tail Bounded Preview)
      const spillRes = this.spill.processOutput(rawResult, toolName, sessionId)
      return { output: spillRes.content }
    } catch (e: any) {
      return { output: '', error: e.message || String(e) }
    }
  }

  /**
   * Build complete augmented system prompt
   */
  public buildPrompt(config: ModelConfig, userQuery: string, sessionId: string): string {
    const memoryContext = this.memory.queryContext(userQuery)
    const evolvedRules = this.evolution.getEvolvedRulesPrompt()

    let prompt = config.systemPrompt
    if (memoryContext) prompt += `\n\n${memoryContext}`
    if (evolvedRules) prompt += evolvedRules
    return prompt
  }
}

export { AgentLoopEngine as AutonomousAgentLoop }
