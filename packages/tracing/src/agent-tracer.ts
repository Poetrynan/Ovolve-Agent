/**
 * @oa/tracing — Agent Tracer
 *
 * High-level tracing abstraction for OvolveAgent's agent loop.
 * Provides turn-level lifecycle management with automatic correlation
 * of LLM calls, tool executions, and custom events to a single trace.
 *
 * Integration:
 *   - AgentLoop imports AgentTracer from @oa/tracing
 *   - AgentTracer emits events that EventStore records
 *   - Each agent turn = one Trace
 *   - Each LLM call = one Generation
 *   - Each tool execution = one Span
 *   - Custom events (fold, memory, security) = Event
 */

import { v4 as uuid } from 'uuid';
import { LangfuseClientWrapper } from './langfuse-client';
import type {
  TracingConfig,
  TraceContext,
  GenerationContext,
  GenerationResult,
  SpanContext,
  SpanResult,
  EventContext,
  AgentTurnContext,
  TraceLlmCallOptions,
  TraceToolCallOptions,
  AgentDecision,
  ObservationLevel,
} from './types';
import { DEFAULT_TRACING_CONFIG } from './types';

// ---------------------------------------------------------------------------
// AgentTracer — High-level agent tracing
// ---------------------------------------------------------------------------

export class AgentTracer {
  private client: LangfuseClientWrapper;
  private config: TracingConfig;
  private activeTurns: Map<string, AgentTurnContext> = new Map();
  private eventListeners: Map<string, Set<(data: unknown) => void>> = new Map();

  constructor(config: Partial<TracingConfig> = {}) {
    const fullConfig = { ...DEFAULT_TRACING_CONFIG, ...config } as TracingConfig;
    this.config = fullConfig;
    this.client = new LangfuseClientWrapper(fullConfig);
  }

  /**
   * Get the resolved tracing configuration.
   */
  getConfig(): TracingConfig {
    return { ...this.config };
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Initialize the underlying Langfuse client.
   */
  async initialize(): Promise<void> {
    await this.client.initialize();
  }

  // -------------------------------------------------------------------------
  // Turn Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start tracing an agent turn. Creates a new Langfuse trace.
   *
   * @param sessionId — The session ID this turn belongs to.
   * @param userMessage — The user's input message.
   * @returns The trace context, or null if tracing is disabled.
   */
  startTurn(sessionId: string, userMessage: string): TraceContext | null {
    const trace = this.client.trace(sessionId, {
      name: `turn:${sessionId}`,
      input: { message: userMessage },
      metadata: {
        userMessage,
        turnStart: Date.now(),
      },
    });

    if (!trace) return null;

    const turnContext: AgentTurnContext = {
      sessionId,
      traceId: trace.traceId,
      startTime: trace.startTime,
      activeGenerations: new Map(),
      activeSpans: new Map(),
      active: true,
    };

    this.activeTurns.set(sessionId, turnContext);
    this.emit('turn:start', { sessionId, traceId: trace.traceId, userMessage });

    return trace;
  }

  /**
   * End tracing for an agent turn. Finalizes the trace with the result.
   *
   * @param sessionId — The session ID.
   * @param result — The final turn result.
   * @returns The generation result, or null if tracing is disabled.
   */
  endTurn(
    sessionId: string,
    result: { output?: unknown; endReason?: string; totalDuration?: number; usage?: unknown }
  ): GenerationResult | null {
    const turn = this.activeTurns.get(sessionId);
    if (!turn || !turn.active) return null;

    turn.active = false;

    // End any remaining active spans/generations
    for (const [key, spanId] of turn.activeSpans) {
      this.client.endSpan(spanId, turn.traceId, {
        name: key,
        isError: true,
        errorMessage: 'Turn ended before span completed',
      });
    }
    turn.activeSpans.clear();

    for (const [key, genId] of turn.activeGenerations) {
      this.client.endGeneration(genId, turn.traceId, {
        output: { error: 'Turn ended before generation completed' },
        metadata: { incomplete: true },
      });
    }
    turn.activeGenerations.clear();

    // Update the trace with final output
    this.client.updateTrace(turn.traceId, {
      output: result.output,
      metadata: {
        endReason: result.endReason,
        totalDuration: result.totalDuration,
        usage: result.usage,
      },
    });

    this.emit('turn:end', {
      sessionId,
      traceId: turn.traceId,
      endReason: result.endReason,
      duration: result.totalDuration,
    });

    this.activeTurns.delete(sessionId);
    return null;
  }

  // -------------------------------------------------------------------------
  // LLM Call Tracing
  // -------------------------------------------------------------------------

  /**
   * Trace an LLM call — records both request and response as a generation.
   *
   * @param sessionId — The session ID.
   * @param options — The LLM call options (request + response).
   * @returns The generation result, or null if tracing is disabled.
   */
  traceLlmCall(sessionId: string, options: TraceLlmCallOptions): GenerationResult | null {
    const turn = this.activeTurns.get(sessionId);
    if (!turn || !turn.active) return null;

    const { request, response } = options;
    const correlationKey = options.correlationKey ?? response.id;
    const startTime = options.startTime ?? Date.now() - (response.usage?.duration ?? 0);
    const endTime = options.endTime ?? Date.now();

    // Create the generation
    const genContext = this.client.generation(turn.traceId, {
      name: `llm:${response.model}`,
      model: response.model,
      providerId: response.providerId,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      topP: request.topP,
      input: {
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
      },
      output: {
        message: response.message,
        toolCalls: response.toolCalls,
        finishReason: response.finishReason,
        reasoning: response.reasoning,
      },
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
        cost: response.usage.cost,
        duration: response.usage.duration,
      },
      metadata: {
        step: (request.metadata as Record<string, unknown>)?.step,
        correlationKey,
        finishReason: response.finishReason,
        cachedTokens: response.usage.cachedTokens,
      },
      completionStartTime: startTime,
    });

    if (genContext) {
      turn.activeGenerations.set(correlationKey, genContext.id);
    }

    // End the generation immediately since we have the full response
    const result = this.client.endGeneration(
      genContext?.id ?? correlationKey,
      turn.traceId,
      {
        output: {
          message: response.message,
          toolCalls: response.toolCalls,
          finishReason: response.finishReason,
          reasoning: response.reasoning,
        },
        usage: {
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          cost: response.usage.cost,
          duration: response.usage.duration,
        },
        metadata: {
          finishReason: response.finishReason,
          correlationKey,
        },
        finishReason: response.finishReason,
        startTime,
      }
    );

    // Remove from active generations
    turn.activeGenerations.delete(correlationKey);

    this.emit('llm:call', {
      sessionId,
      traceId: turn.traceId,
      model: response.model,
      usage: response.usage,
      finishReason: response.finishReason,
    });

    return result;
  }

  /**
   * Start tracing an LLM call (for streaming scenarios).
   * Returns a correlation key to use with endLlmCall.
   */
  startLlmCall(
    sessionId: string,
    request: TraceLlmCallOptions['request']
  ): { correlationKey: string; generationId: string } | null {
    const turn = this.activeTurns.get(sessionId);
    if (!turn || !turn.active) return null;

    const correlationKey = uuid();
    const startTime = Date.now();

    const genContext = this.client.generation(turn.traceId, {
      name: `llm:${request.model}`,
      model: request.model,
      providerId: request.providerId ?? 'unknown',
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      topP: request.topP,
      input: {
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
      },
      metadata: {
        correlationKey,
        streaming: true,
      },
      completionStartTime: startTime,
    });

    if (genContext) {
      turn.activeGenerations.set(correlationKey, genContext.id);
      return { correlationKey, generationId: genContext.id };
    }

    return null;
  }

  /**
   * End a streaming LLM call with the final response.
   */
  endLlmCall(
    sessionId: string,
    correlationKey: string,
    response: TraceLlmCallOptions['response']
  ): GenerationResult | null {
    const turn = this.activeTurns.get(sessionId);
    if (!turn || !turn.active) return null;

    const generationId = turn.activeGenerations.get(correlationKey);
    if (!generationId) return null;

    const result = this.client.endGeneration(generationId, turn.traceId, {
      output: {
        message: response.message,
        toolCalls: response.toolCalls,
        finishReason: response.finishReason,
        reasoning: response.reasoning,
      },
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
        cost: response.usage.cost,
        duration: response.usage.duration,
      },
      metadata: {
        finishReason: response.finishReason,
        correlationKey,
      },
      finishReason: response.finishReason,
    });

    turn.activeGenerations.delete(correlationKey);

    this.emit('llm:call', {
      sessionId,
      traceId: turn.traceId,
      model: response.model,
      usage: response.usage,
      finishReason: response.finishReason,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Tool Call Tracing
  // -------------------------------------------------------------------------

  /**
   * Trace a tool execution — records as a span within the trace.
   *
   * @param sessionId — The session ID.
   * @param options — The tool call options.
   * @returns The span result, or null if tracing is disabled.
   */
  traceToolCall(sessionId: string, options: TraceToolCallOptions): SpanResult | null {
    const turn = this.activeTurns.get(sessionId);
    if (!turn || !turn.active) return null;

    const { toolName, input, output, isError, errorMessage, startTime, endTime } = options;
    const correlationKey = options.correlationKey ?? `${toolName}:${uuid()}`;

    // Create the span
    const spanContext = this.client.span(turn.traceId, {
      name: `tool:${toolName}`,
      input,
      output,
      metadata: {
        toolName,
        duration: endTime - startTime,
        isError: isError ?? false,
        toolCallId: options.toolCallId,
        correlationKey,
      },
      level: isError ? 'ERROR' : 'DEFAULT',
      parentObservationId: this.resolveParentObservation(turn, options.correlationKey),
    });

    if (spanContext) {
      turn.activeSpans.set(correlationKey, spanContext.id);
    }

    // End the span immediately since we have the full result
    const result = this.client.endSpan(
      spanContext?.id ?? correlationKey,
      turn.traceId,
      {
        name: `tool:${toolName}`,
        toolName,
        input,
        output,
        isError: isError ?? false,
        errorMessage,
        metadata: {
          toolName,
          duration: endTime - startTime,
          toolCallId: options.toolCallId,
        },
        level: isError ? 'ERROR' : 'DEFAULT',
        startTime,
      }
    );

    turn.activeSpans.delete(correlationKey);

    this.emit('tool:call', {
      sessionId,
      traceId: turn.traceId,
      toolName,
      duration: endTime - startTime,
      isError: isError ?? false,
    });

    return result;
  }

  /**
   * Start tracing a tool execution (for async scenarios).
   */
  startToolCall(
    sessionId: string,
    toolName: string,
    input: unknown,
    options: { toolCallId?: string; correlationKey?: string } = {}
  ): { correlationKey: string; spanId: string } | null {
    const turn = this.activeTurns.get(sessionId);
    if (!turn || !turn.active) return null;

    const correlationKey = options.correlationKey ?? `${toolName}:${uuid()}`;
    const startTime = Date.now();

    const spanContext = this.client.span(turn.traceId, {
      name: `tool:${toolName}`,
      input,
      metadata: {
        toolName,
        toolCallId: options.toolCallId,
        correlationKey,
      },
      parentObservationId: this.resolveParentObservation(turn, options.correlationKey),
    });

    if (spanContext) {
      turn.activeSpans.set(correlationKey, spanContext.id);
      return { correlationKey, spanId: spanContext.id };
    }

    return null;
  }

  /**
   * End a tool execution span.
   */
  endToolCall(
    sessionId: string,
    correlationKey: string,
    result: { output?: unknown; isError?: boolean; errorMessage?: string; startTime?: number }
  ): SpanResult | null {
    const turn = this.activeTurns.get(sessionId);
    if (!turn || !turn.active) return null;

    const spanId = turn.activeSpans.get(correlationKey);
    if (!spanId) return null;

    const spanResult = this.client.endSpan(spanId, turn.traceId, {
      output: result.output,
      isError: result.isError ?? false,
      errorMessage: result.errorMessage,
      startTime: result.startTime,
    });

    turn.activeSpans.delete(correlationKey);

    this.emit('tool:call:end', {
      sessionId,
      traceId: turn.traceId,
      correlationKey,
      isError: result.isError ?? false,
    });

    return spanResult;
  }

  // -------------------------------------------------------------------------
  // Agent Decision Tracing
  // -------------------------------------------------------------------------

  /**
   * Trace an agent decision (reasoning, context assembly, tool selection).
   *
   * @param sessionId — The session ID.
   * @param decision — The agent decision to trace.
   * @returns The event context, or null if tracing is disabled.
   */
  traceAgentDecision(sessionId: string, decision: AgentDecision): EventContext | null {
    const turn = this.activeTurns.get(sessionId);
    if (!turn || !turn.active) return null;

    const eventContext = this.client.event(turn.traceId, {
      name: `decision:${decision.type}`,
      input: {
        summary: decision.summary,
        reasoning: decision.reasoning,
      },
      output: {
        metadata: decision.metadata,
      },
      metadata: {
        decisionType: decision.type,
        ...decision.metadata,
      },
      level: decision.type === 'error' ? 'ERROR' : 'DEFAULT',
    });

    this.emit('agent:decision', {
      sessionId,
      traceId: turn.traceId,
      decisionType: decision.type,
      summary: decision.summary,
    });

    return eventContext;
  }

  // -------------------------------------------------------------------------
  // Custom Event Tracing
  // -------------------------------------------------------------------------

  /**
   * Record a custom event (fold, memory, security, etc.).
   *
   * @param sessionId — The session ID.
   * @param eventName — The event name.
   * @param data — The event data.
   * @param level — The observation level.
   * @returns The event context, or null if tracing is disabled.
   */
  traceCustomEvent(
    sessionId: string,
    eventName: string,
    data: { input?: unknown; output?: unknown; metadata?: Record<string, unknown> } = {},
    level: ObservationLevel = 'DEFAULT'
  ): EventContext | null {
    const turn = this.activeTurns.get(sessionId);
    if (!turn || !turn.active) return null;

    return this.client.event(turn.traceId, {
      name: eventName,
      input: data.input,
      output: data.output,
      metadata: data.metadata,
      level,
    });
  }

  /**
   * Trace a memory operation.
   */
  traceMemoryEvent(
    sessionId: string,
    operation: 'add' | 'update' | 'delete' | 'retrieve',
    data: { input?: unknown; output?: unknown; metadata?: Record<string, unknown> }
  ): EventContext | null {
    return this.traceCustomEvent(sessionId, `memory:${operation}`, data);
  }

  /**
   * Trace a security event.
   */
  traceSecurityEvent(
    sessionId: string,
    eventType: string,
    data: { input?: unknown; output?: unknown; metadata?: Record<string, unknown> },
    level: ObservationLevel = 'WARNING'
  ): EventContext | null {
    return this.traceCustomEvent(sessionId, `security:${eventType}`, data, level);
  }

  /**
   * Trace a context fold operation.
   */
  traceFoldEvent(
    sessionId: string,
    data: { input?: unknown; output?: unknown; metadata?: Record<string, unknown> }
  ): EventContext | null {
    return this.traceCustomEvent(sessionId, `fold:${data.metadata?.['foldType'] ?? 'default'}`, data);
  }

  // -------------------------------------------------------------------------
  // Score
  // -------------------------------------------------------------------------

  /**
   * Record a numeric score for the current turn.
   */
  score(
    sessionId: string,
    name: string,
    value: number,
    options: { comment?: string } = {}
  ): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn || !turn.active) return;

    this.client.score(turn.traceId, name, value, options);
  }

  // -------------------------------------------------------------------------
  // Flush & Shutdown
  // -------------------------------------------------------------------------

  /**
   * Flush pending events to Langfuse.
   */
  flush(): Promise<{ success: boolean; eventsFlushed: number; error?: string }> {
    return this.client.flush();
  }

  /**
   * Gracefully shutdown the tracer.
   */
  async shutdown(): Promise<void> {
    // End all active turns
    for (const [sessionId, turn] of this.activeTurns) {
      if (turn.active) {
        this.endTurn(sessionId, {
          endReason: 'shutdown',
          output: { error: 'Tracer shut down' },
        });
      }
    }
    this.activeTurns.clear();

    await this.client.shutdown();
    this.eventListeners.clear();
  }

  // -------------------------------------------------------------------------
  // Health & Status
  // -------------------------------------------------------------------------

  /**
   * Get current health status.
   */
  health() {
    return this.client.health();
  }

  /**
   * Whether tracing is enabled and active.
   */
  isEnabled(): boolean {
    return this.client.isEnabled();
  }

  /**
   * Get the active turn context for a session.
   */
  getActiveTurn(sessionId: string): AgentTurnContext | undefined {
    return this.activeTurns.get(sessionId);
  }

  // -------------------------------------------------------------------------
  // Event Emitter (for EventStore integration)
  // -------------------------------------------------------------------------

  /**
   * Subscribe to tracer events.
   */
  on(event: string, listener: (data: unknown) => void): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);

    // Return unsubscribe function
    return () => {
      this.eventListeners.get(event)?.delete(listener);
    };
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(event: string, data: unknown): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;

    for (const listener of listeners) {
      try {
        listener(data);
      } catch (error) {
        console.warn(`[AgentTracer] Event listener error for "${event}":`, error);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the parent observation ID for nesting spans under generations.
   */
  private resolveParentObservation(
    turn: AgentTurnContext,
    correlationKey?: string
  ): string | undefined {
    if (!correlationKey) return undefined;
    return turn.activeGenerations.get(correlationKey) ?? undefined;
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create an AgentTracer instance with the given configuration.
 */
export function createAgentTracer(config: Partial<TracingConfig> = {}): AgentTracer {
  return new AgentTracer(config);
}
