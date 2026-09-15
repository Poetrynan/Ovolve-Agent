/**
 * Main AgentLoop class.
 *
 * Implements an event-driven agent loop with
 * design and Ovolve's 5-step decision chain:
 *   1. Perceive — assemble context from session state
 *   2. Think — stream LLM response
 *   3. Act — execute tool calls
 *   4. Observe — collect tool results
 *   5. Decide — continue or stop
 *
 * Supports steering (mid-turn interruption), pause/resume, and follow-up
 * message injection.
 */

import { v4 as uuid } from 'uuid';
import type { LlmClient, ToolDefinition, ToolCall } from '@oa/llm';
import type {
  AgentLoopConfig,
  SessionState,
  TurnOptions,
  SteeringMessage,
  FollowUpMessage,
  AgentEvent,
  TurnResult,
  StepResult,
  ToolResult,
  TokenUsage,
  Logger,
} from './types.js';
import { executeStep, StepExecutorConfig } from './step-executor.js';
import { createContextAssembler } from './context-assembler.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Partial<AgentLoopConfig> = {
  maxSteps: 25,
  maxToolCallsPerStep: 50,
  toolExecutionMode: 'parallel',
  maxParallelTools: 8,
  turnTimeout: 600_000,
  enableMemoryInjection: true,
  enableSkillInjection: true,
};

const DEFAULT_LOGGER: Logger = {
  debug: () => {},
  info: console.info,
  warn: console.warn,
  error: console.error,
};

// ---------------------------------------------------------------------------
// Agent Loop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private config: AgentLoopConfig;
  private sessions = new Map<string, SessionState>();
  private eventListeners = new Set<(event: AgentEvent) => void>();
  private logger: Logger;

  constructor(config: AgentLoopConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = config.logger ?? DEFAULT_LOGGER;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run a turn: process a user message through the agent loop.
   * Yields events as they occur.
   */
  async *run(sessionId: string, userMessage: string): AsyncGenerator<AgentEvent> {
    const options: TurnOptions = { userMessage };
    yield* this.runWithOptions(sessionId, options);
  }

  /**
   * Run a turn with full options.
   */
  async *runWithOptions(sessionId: string, options: TurnOptions): AsyncGenerator<AgentEvent> {
    const startTime = Date.now();

    // Get or create session.
    const session = this.getOrCreateSession(sessionId, options);

    // Set up abort controller.
    const abortController = new AbortController();
    session.abortController = abortController;

    // Link external abort signal if provided.
    if (options.signal) {
      options.signal.addEventListener('abort', () => abortController.abort());
    }

    // Set session status.
    session.status = 'running';
    session.startTime = startTime;
    session.lastActivity = startTime;

    // Add user message to session.
    session.messages.push({
      role: 'user',
      content: options.userMessage,
    });

    // Emit turn start.
    const turnStartEvent: AgentEvent = {
      type: 'agent:turn_start',
      sessionId,
      timestamp: Date.now(),
      data: { userMessage: options.userMessage },
    };
    yield turnStartEvent;
    this.emit(turnStartEvent);

    const steps: StepResult[] = [];
    let endReason: TurnResult['endReason'] = 'natural_stop';
    let finalMessage = '';

    try {
      // Main step loop.
      for (let step = 0; step < this.config.maxSteps; step++) {
        // Check for stop.
        if (session.status === 'stopped') {
          endReason = 'stopped';
          break;
        }

        // Check for timeout.
        if (Date.now() - startTime > this.config.turnTimeout) {
          endReason = 'timeout';
          break;
        }

        // Check for pause.
        if (session.paused) {
          await this.waitForResume(session);
        }

        session.currentStep = step + 1;
        session.toolCallsThisStep = 0;

        // Execute a single step.
        const stepResult = await this.executeStep(session, options);
        steps.push(stepResult);

        // Update cumulative usage.
        session.usage = addUsage(session.usage, stepResult.response.usage);

        // Check for natural stop (no tool calls).
        if (stepResult.naturalStop) {
          finalMessage = extractTextContent(stepResult.response.message.content);

          // Check for follow-up messages.
          if (session.followUpQueue.length > 0) {
            const followUp = session.followUpQueue.shift()!;
            session.messages.push({
              role: 'user',
              content: followUp.message,
            });

            const followUpEvent: AgentEvent = {
              type: 'agent:followup_injected',
              sessionId,
              timestamp: Date.now(),
              data: followUp,
            };
            yield followUpEvent;
            this.emit(followUpEvent);

            // Continue the loop with the follow-up.
            endReason = 'follow_up';
            continue;
          }

          endReason = 'natural_stop';
          break;
        }

        // Check tool call limit.
        if (session.toolCallsThisStep >= this.config.maxToolCallsPerStep) {
          endReason = 'max_steps_reached';
          break;
        }
      }

      // If we exhausted steps without natural stop.
      if (steps.length >= this.config.maxSteps && endReason === 'natural_stop') {
        endReason = 'max_steps_reached';
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      endReason = 'error';

      const errorEvent: AgentEvent = {
        type: 'agent:error',
        sessionId,
        timestamp: Date.now(),
        data: { error, step: session.currentStep },
      };
      yield errorEvent;
      this.emit(errorEvent);

      this.logger.error(`Agent loop error for session ${sessionId}:`, error);
    } finally {
      session.status = endReason === 'error' ? 'error' : (endReason === 'stopped' ? 'stopped' : 'completed');
      session.abortController = null;
    }

    const totalDuration = Date.now() - startTime;

    const turnResult: TurnResult = {
      sessionId,
      steps,
      totalDuration,
      finalMessage,
      usage: session.usage,
      endReason,
    };

    const turnEndEvent: AgentEvent = {
      type: 'agent:turn_end',
      sessionId,
      timestamp: Date.now(),
      data: turnResult,
    };
    yield turnEndEvent;
    this.emit(turnEndEvent);
  }

  /**
   * Steer the agent mid-turn by injecting an instruction.
   */
  steer(sessionId: string, instruction: string, priority: 'high' | 'normal' = 'normal'): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.warn(`Cannot steer: session ${sessionId} not found`);
      return;
    }

    const steering: SteeringMessage = {
      id: uuid(),
      sessionId,
      instruction,
      priority,
      timestamp: Date.now(),
    };

    session.steeringQueue.push(steering);

    const event: AgentEvent = {
      type: 'agent:steering_received',
      sessionId,
      timestamp: Date.now(),
      data: steering,
    };
    this.emit(event);
  }

  /**
   * Queue a follow-up message to be injected after the agent naturally stops.
   */
  queueFollowUp(sessionId: string, message: string, delay: number = 0, condition?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.warn(`Cannot queue follow-up: session ${sessionId} not found`);
      return;
    }

    const followUp: FollowUpMessage = {
      id: uuid(),
      sessionId,
      message,
      delay,
      condition,
      timestamp: Date.now(),
    };

    session.followUpQueue.push(followUp);

    const event: AgentEvent = {
      type: 'agent:followup_queued',
      sessionId,
      timestamp: Date.now(),
      data: followUp,
    };
    this.emit(event);
  }

  /**
   * Pause the current turn.
   */
  pause(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') return;

    session.paused = true;

    const event: AgentEvent = {
      type: 'agent:paused',
      sessionId,
      timestamp: Date.now(),
      data: { step: session.currentStep },
    };
    this.emit(event);
  }

  /**
   * Resume a paused turn.
   */
  resume(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.paused) return;

    session.paused = false;
    session.pauseResume?.();

    const event: AgentEvent = {
      type: 'agent:resumed',
      sessionId,
      timestamp: Date.now(),
      data: { step: session.currentStep },
    };
    this.emit(event);
  }

  /**
   * Stop the current turn.
   */
  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'stopped';
    session.paused = false;
    session.pauseResume?.();
    session.abortController?.abort();

    const event: AgentEvent = {
      type: 'agent:stopped',
      sessionId,
      timestamp: Date.now(),
      data: { step: session.currentStep },
    };
    this.emit(event);
  }

  /**
   * Get the current state of a session.
   */
  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions.
   */
  getActiveSessions(): SessionState[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === 'running' || s.status === 'paused',
    );
  }

  /**
   * Delete a session and free its resources.
   */
  deleteSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abortController?.abort();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Subscribe to agent events.
   */
  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Emit an event to all listeners.
   */
  private emit(event: AgentEvent): void {
    this.config.onEvent?.(event);
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error('Event listener error:', err);
      }
    }
  }

  /**
   * Get existing session or create a new one.
   */
  private getOrCreateSession(sessionId: string, options: TurnOptions): SessionState {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        id: sessionId,
        messages: [],
        status: 'idle',
        currentStep: 0,
        toolCallsThisStep: 0,
        startTime: Date.now(),
        lastActivity: Date.now(),
        steeringQueue: [],
        followUpQueue: [],
        abortController: null,
        paused: false,
        usage: zeroUsage(),
        metadata: options.additionalContext ?? {},
      };
      this.sessions.set(sessionId, session);
    }

    return session;
  }

  /**
   * Wait for a paused session to be resumed.
   */
  private waitForResume(session: SessionState): Promise<void> {
    return new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!session.paused || session.status === 'stopped') {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      // Also resolve immediately if resume is called.
      session.pauseResume = () => {
        clearInterval(checkInterval);
        session.pauseResume = null;
        resolve();
      };
    });
  }

  /**
   * Execute a single step using the step executor.
   */
  private async executeStep(session: SessionState, options: TurnOptions): Promise<StepResult> {
    const contextConfig = createContextAssembler({
      systemPrompt: this.config.systemPrompt,
      toolDefs: this.getToolDefs(options),
      enableMemoryInjection: this.config.enableMemoryInjection,
      enableSkillInjection: this.config.enableSkillInjection,
      onEvent: (event) => this.emit(event),
    });

    const stepConfig: StepExecutorConfig = {
      llmClient: this.config.llmClient,
      contextConfig,
      executeTool: (toolCall, toolDefs, signal) =>
        this.dispatchTool(toolCall, toolDefs, signal),
      maxParallelTools: this.config.maxParallelTools,
      toolExecutionMode: this.config.toolExecutionMode,
      onEvent: (event) => this.emit(event),
      logger: this.logger,
    };

    return executeStep(session, stepConfig, options);
  }

  /**
   * Dispatch a tool call to the tool registry.
   * This is a placeholder that should be overridden or configured.
   */
  private async dispatchTool(
    toolCall: ToolCall,
    toolDefs: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const startTime = Date.now();

    // Find the tool definition.
    const toolDef = toolDefs.find((t) => t.function.name === toolCall.function.name);
    if (!toolDef) {
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        content: `Error: Tool "${toolCall.function.name}" not found`,
        isError: true,
        duration: Date.now() - startTime,
      };
    }

    try {
      // Parse arguments.
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

      // In a real implementation, this would call the ToolRegistry.
      // For now, return a placeholder result.
      const result: ToolResult = {
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        content: `Tool "${toolCall.function.name}" executed with args: ${JSON.stringify(args)}`,
        isError: false,
        duration: Date.now() - startTime,
      };

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        content: `Error parsing arguments: ${error.message}`,
        isError: true,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Get tool definitions for a turn.
   */
  private getToolDefs(_options: TurnOptions): ToolDefinition[] {
    // In a real implementation, this would come from ToolRegistry.
    // Return empty array as default.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

function zeroUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cost: 0,
    duration: 0,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cost: a.cost + b.cost,
    duration: a.duration + b.duration,
  };
}

function extractTextContent(content: string | import('@oa/llm').ContentBlock[]): string {
  if (typeof content === 'string') return content;

  return content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('');
}
