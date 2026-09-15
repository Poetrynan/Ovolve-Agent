/**
 * @oa/tracing — Langfuse Client Wrapper
 *
 * Low-level wrapper around the Langfuse SDK providing trace/generation/span/event
 * creation with graceful degradation when Langfuse is unavailable.
 *
 * All operations are async and non-blocking. Failures are logged to console
 * but never thrown to the caller, ensuring the agent continues operating
 * even when the observability backend is unreachable.
 */

import { v4 as uuid } from 'uuid';
import type {
  TracingConfig,
  TraceContext,
  GenerationContext,
  GenerationResult,
  SpanContext,
  SpanResult,
  EventContext,
  ObservationLevel,
  FlushResult,
  TracingHealth,
} from './types';
import { DEFAULT_TRACING_CONFIG } from './types';

// Langfuse SDK types (imported dynamically to avoid hard dependency)
interface LangfuseClient {
  trace: (options: LangfuseTraceOptions) => LangfuseTraceHandle;
  generation: (options: LangfuseGenerationOptions) => LangfuseObservationHandle;
  span: (options: LangfuseSpanOptions) => LangfuseObservationHandle;
  event: (options: LangfuseEventOptions) => LangfuseObservationHandle;
  score: (options: LangfuseScoreOptions) => void;
  flushAsync: () => Promise<void>;
  shutdownAsync: () => Promise<void>;
}

interface LangfuseTraceOptions {
  id: string;
  name: string;
  sessionId?: string;
  userId?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
  release?: string;
  version?: string;
  public?: boolean;
}

interface LangfuseGenerationOptions {
  traceId: string;
  name?: string;
  startTime?: Date;
  endTime?: Date;
  model?: string;
  modelParameters?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    inputCost?: number;
    outputCost?: number;
    totalCost?: number;
  };
  metadata?: Record<string, unknown>;
  level?: string;
  statusMessage?: string;
  parentObservationId?: string;
  completionStartTime?: Date;
  version?: string;
}

interface LangfuseSpanOptions {
  traceId: string;
  name?: string;
  startTime?: Date;
  endTime?: Date;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: string;
  statusMessage?: string;
  parentObservationId?: string;
  version?: string;
}

interface LangfuseEventOptions {
  traceId: string;
  name: string;
  startTime?: Date;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: string;
  statusMessage?: string;
  parentObservationId?: string;
  version?: string;
}

interface LangfuseScoreOptions {
  traceId: string;
  name: string;
  value: number;
  comment?: string;
  observationId?: string;
  id?: string;
}

interface LangfuseTraceHandle {
  id: string;
  update: (options: Partial<LangfuseTraceOptions>) => LangfuseTraceHandle;
  generation: (options: LangfuseGenerationOptions) => LangfuseObservationHandle;
  span: (options: LangfuseSpanOptions) => LangfuseObservationHandle;
  event: (options: LangfuseEventOptions) => LangfuseObservationHandle;
  score: (options: LangfuseScoreOptions) => void;
}

interface LangfuseObservationHandle {
  id: string;
  update: (options: Partial<LangfuseGenerationOptions | LangfuseSpanOptions | LangfuseEventOptions>) => LangfuseObservationHandle;
  end: (options?: Partial<LangfuseGenerationOptions | LangfuseSpanOptions | LangfuseEventOptions>) => LangfuseObservationHandle;
}

// ---------------------------------------------------------------------------
// LangfuseClientWrapper — Wraps the Langfuse SDK with fault tolerance
// ---------------------------------------------------------------------------

export class LangfuseClientWrapper {
  private client: LangfuseClient | null = null;
  private config: TracingConfig;
  private initialized = false;
  private pendingEvents = 0;
  private totalEventsSent = 0;
  private totalErrors = 0;
  private lastFlushSuccess = true;
  private lastFlushTime?: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private debugLog: (message: string, data?: unknown) => void;

  constructor(config: Partial<TracingConfig>) {
    this.config = { ...DEFAULT_TRACING_CONFIG, ...config } as TracingConfig;
    this.debugLog = this.config.debug
      ? (msg: string, data?: unknown) => console.debug(`[Langfuse] ${msg}`, data ?? '')
      : () => {};
  }

  /**
   * Initialize the Langfuse client. Loads the SDK dynamically so that
   * the tracing package remains functional even if the SDK is not installed.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.debugLog('Already initialized, skipping');
      return;
    }

    if (!this.config.enabled) {
      this.debugLog('Tracing disabled, skipping initialization');
      return;
    }

    if (!this.config.publicKey || !this.config.secretKey) {
      console.warn('[Langfuse] Missing public/secret key — tracing disabled');
      this.config.enabled = false;
      return;
    }

    try {
      // Dynamic import so the `langfuse` package is optional at runtime
      const { Langfuse } = await import('langfuse');

      this.client = new Langfuse({
        publicKey: this.config.publicKey,
        secretKey: this.config.secretKey,
        baseUrl: this.config.baseUrl,
        requestTimeout: this.config.requestTimeout,
        release: this.config.release,
        // SDK handles batching internally; we add our own for custom flush control
        flushAt: this.config.batchSize,
        flushInterval: this.config.flushInterval,
      }) as unknown as LangfuseClient;

      this.initialized = true;
      this.debugLog(`Initialized Langfuse client (${this.config.mode})`, {
        baseUrl: this.config.baseUrl,
        publicKey: this.config.publicKey.slice(0, 8) + '...',
      });

      // Start periodic flush timer
      this.startFlushTimer();
    } catch (error) {
      console.warn('[Langfuse] Failed to initialize SDK — tracing degraded:', error);
      this.client = null;
      this.initialized = false;
    }
  }

  // -------------------------------------------------------------------------
  // Trace — One agent turn
  // -------------------------------------------------------------------------

  /**
   * Create a trace for an agent turn.
   */
  trace(sessionId: string, options: TraceOptions = {}): TraceContext | null {
    if (!this.isEnabled()) {
      return null;
    }

    const traceId = options.traceId ?? uuid();
    const startTime = Date.now();

    try {
      const handle = this.client!.trace({
        id: traceId,
        name: options.name ?? `agent-turn:${sessionId}`,
        sessionId,
        userId: options.userId,
        input: options.input,
        metadata: {
          ...this.config.metadata,
          ...options.metadata,
          sessionId,
          mode: this.config.mode,
        },
        tags: this.buildTags(options.tags),
        release: this.config.release,
      });

      this.debugLog(`Created trace ${traceId}`, { sessionId, name: options.name });

      return {
        traceId: handle.id,
        sessionId,
        name: options.name ?? `agent-turn:${sessionId}`,
        startTime,
        userId: options.userId,
        input: options.input,
        tags: this.buildTags(options.tags),
        metadata: {
          ...this.config.metadata,
          ...options.metadata,
          sessionId,
        },
      };
    } catch (error) {
      this.handleError('trace', error);
      return null;
    }
  }

  /**
   * Update an existing trace (e.g., to set final output).
   */
  updateTrace(traceId: string, options: Partial<TraceOptions>): void {
    if (!this.isEnabled()) return;

    try {
      this.client!.trace({
        id: traceId,
        name: options.name ?? 'agent-turn',
        sessionId: options.sessionId,
        input: options.input,
        output: options.output,
        metadata: options.metadata,
        tags: options.tags,
      }).update({
        output: options.output,
        metadata: options.metadata,
        tags: this.buildTags(options.tags),
      });

      this.debugLog(`Updated trace ${traceId}`);
    } catch (error) {
      this.handleError('updateTrace', error);
    }
  }

  // -------------------------------------------------------------------------
  // Generation — One LLM call
  // -------------------------------------------------------------------------

  /**
   * Record an LLM generation call within a trace.
   */
  generation(traceId: string, options: GenerationOptions): GenerationContext | null {
    if (!this.isEnabled()) return null;

    const id = options.id ?? uuid();
    const startTime = Date.now();

    try {
      const modelParameters: Record<string, unknown> = {
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        top_p: options.topP,
        ...options.modelParameters,
      };

      const handle = this.client!.generation({
        traceId,
        name: options.name ?? 'llm-call',
        startTime: new Date(startTime),
        model: options.model,
        modelParameters,
        input: options.input ?? options.messages,
        output: options.output,
        usage: options.usage
          ? {
              promptTokens: options.usage.promptTokens,
              completionTokens: options.usage.completionTokens,
              totalTokens: options.usage.totalTokens,
              inputCost: options.usage.cost,
              outputCost: undefined,
              totalCost: options.usage.cost,
            }
          : undefined,
        metadata: {
          ...options.metadata,
          providerId: options.providerId,
          duration: options.usage?.duration,
        },
        level: options.level,
        parentObservationId: options.parentObservationId,
        completionStartTime: options.completionStartTime
          ? new Date(options.completionStartTime)
          : undefined,
      });

      this.pendingEvents++;
      this.debugLog(`Created generation ${id} on trace ${traceId}`, {
        model: options.model,
        providerId: options.providerId,
      });

      return {
        id: handle.id,
        traceId,
        model: options.model,
        providerId: options.providerId,
        request: options.input as GenerationContext['request'],
        startTime,
      };
    } catch (error) {
      this.handleError('generation', error);
      return null;
    }
  }

  /**
   * Update an existing generation with response data.
   */
  updateGeneration(
    generationId: string,
    traceId: string,
    options: UpdateGenerationOptions
  ): void {
    if (!this.isEnabled()) return;

    try {
      this.client!.generation({
        traceId,
        name: 'llm-call',
      }).update({
        output: options.output,
        usage: options.usage
          ? {
              promptTokens: options.usage.promptTokens,
              completionTokens: options.usage.completionTokens,
              totalTokens: options.usage.totalTokens,
              totalCost: options.usage.cost,
            }
          : undefined,
        metadata: options.metadata,
        endTime: new Date(),
      });

      this.debugLog(`Updated generation ${generationId}`);
    } catch (error) {
      this.handleError('updateGeneration', error);
    }
  }

  /**
   * End a generation with final response data.
   */
  endGeneration(
    generationId: string,
    traceId: string,
    options: EndGenerationOptions
  ): GenerationResult | null {
    if (!this.isEnabled()) return null;

    const endTime = Date.now();

    try {
      this.client!.generation({
        traceId,
        name: 'llm-call',
      }).end({
        output: options.output,
        usage: options.usage
          ? {
              promptTokens: options.usage.promptTokens,
              completionTokens: options.usage.completionTokens,
              totalTokens: options.usage.totalTokens,
              totalCost: options.usage.cost,
            }
          : undefined,
        metadata: {
          ...options.metadata,
          duration: options.usage?.duration,
          finishReason: options.finishReason,
        },
        endTime: new Date(endTime),
      });

      this.pendingEvents++;
      this.debugLog(`Ended generation ${generationId}`, {
        duration: options.usage?.duration,
        totalTokens: options.usage?.totalTokens,
      });

      return {
        id: generationId,
        traceId,
        response: options.output as GenerationResult['response'],
        endTime,
      };
    } catch (error) {
      this.handleError('endGeneration', error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Span — Tool execution
  // -------------------------------------------------------------------------

  /**
   * Create a span for tool execution.
   */
  span(traceId: string, options: SpanOptions): SpanContext | null {
    if (!this.isEnabled()) return null;

    const id = options.id ?? uuid();
    const startTime = Date.now();

    try {
      this.client!.span({
        traceId,
        name: options.name,
        startTime: new Date(startTime),
        input: options.input,
        output: options.output,
        metadata: options.metadata,
        level: options.level ?? 'DEFAULT',
        parentObservationId: options.parentObservationId,
      });

      this.pendingEvents++;
      this.debugLog(`Created span ${id} on trace ${traceId}`, { name: options.name });

      return {
        id,
        traceId,
        parentId: options.parentObservationId,
        name: options.name,
        level: options.level ?? 'DEFAULT',
        startTime,
      };
    } catch (error) {
      this.handleError('span', error);
      return null;
    }
  }

  /**
   * End a span with final output.
   */
  endSpan(
    spanId: string,
    traceId: string,
    options: EndSpanOptions
  ): SpanResult | null {
    if (!this.isEnabled()) return null;

    const endTime = Date.now();

    try {
      this.client!.span({
        traceId,
        name: options.name ?? 'span',
      }).end({
        output: options.output,
        input: options.input,
        metadata: options.metadata,
        level: options.isError ? 'ERROR' : options.level ?? 'DEFAULT',
        statusMessage: options.errorMessage,
        endTime: new Date(endTime),
      });

      this.pendingEvents++;
      this.debugLog(`Ended span ${spanId}`, {
        isError: options.isError,
        duration: endTime - (options.startTime ?? endTime),
      });

      return {
        id: spanId,
        traceId,
        toolName: options.toolName,
        input: options.input,
        output: options.output,
        endTime,
        isError: options.isError ?? false,
        errorMessage: options.errorMessage,
      };
    } catch (error) {
      this.handleError('endSpan', error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Event — Custom event (fold, memory, security)
  // -------------------------------------------------------------------------

  /**
   * Record a custom event within a trace.
   */
  event(traceId: string, options: EventOptions): EventContext | null {
    if (!this.isEnabled()) return null;

    const id = options.id ?? uuid();
    const timestamp = Date.now();

    try {
      this.client!.event({
        traceId,
        name: options.name,
        startTime: new Date(timestamp),
        input: options.input,
        output: options.output,
        metadata: options.metadata,
        level: options.level ?? 'DEFAULT',
        parentObservationId: options.parentObservationId,
      });

      this.pendingEvents++;
      this.debugLog(`Created event ${id} on trace ${traceId}`, { name: options.name });

      return {
        id,
        traceId,
        parentId: options.parentObservationId,
        name: options.name,
        level: options.level ?? 'DEFAULT',
        timestamp,
        input: options.input,
        output: options.output,
        metadata: options.metadata,
      };
    } catch (error) {
      this.handleError('event', error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Score — Numeric score for a trace or observation
  // -------------------------------------------------------------------------

  /**
   * Record a numeric score (e.g., user feedback, quality metric).
   */
  score(
    traceId: string,
    name: string,
    value: number,
    options: { comment?: string; observationId?: string } = {}
  ): void {
    if (!this.isEnabled()) return;

    try {
      this.client!.score({
        traceId,
        name,
        value,
        comment: options.comment,
        observationId: options.observationId,
      });

      this.pendingEvents++;
      this.debugLog(`Recorded score ${name}=${value} on trace ${traceId}`);
    } catch (error) {
      this.handleError('score', error);
    }
  }

  // -------------------------------------------------------------------------
  // Flush & Shutdown
  // -------------------------------------------------------------------------

  /**
   * Flush pending events to Langfuse. Called automatically on a timer
   * but can be called manually for immediate flushing.
   */
  async flush(): Promise<FlushResult> {
    if (!this.isEnabled() || !this.client) {
      return { success: true, eventsFlushed: 0 };
    }

    try {
      await this.client.flushAsync();
      this.lastFlushSuccess = true;
      this.lastFlushTime = Date.now();
      this.totalEventsSent += this.pendingEvents;
      const flushed = this.pendingEvents;
      this.pendingEvents = 0;

      this.debugLog(`Flushed ${flushed} events`);
      return { success: true, eventsFlushed: flushed };
    } catch (error) {
      this.lastFlushSuccess = false;
      this.totalErrors++;
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[Langfuse] Flush failed:', message);
      return { success: false, eventsFlushed: 0, error: message };
    }
  }

  /**
   * Gracefully shutdown the client, flushing any remaining events.
   */
  async shutdown(): Promise<void> {
    this.debugLog('Shutting down Langfuse client');

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.client && this.initialized) {
      try {
        await this.flush();
        await this.client.shutdownAsync();
        this.debugLog('Langfuse client shut down cleanly');
      } catch (error) {
        console.warn('[Langfuse] Shutdown error:', error);
      }
    }

    this.client = null;
    this.initialized = false;
  }

  // -------------------------------------------------------------------------
  // Health & Status
  // -------------------------------------------------------------------------

  /**
   * Get current health status of the tracing subsystem.
   */
  health(): TracingHealth {
    return {
      initialized: this.initialized,
      lastFlushSuccess: this.lastFlushSuccess,
      lastFlushTime: this.lastFlushTime,
      pendingEvents: this.pendingEvents,
      totalEventsSent: this.totalEventsSent,
      totalErrors: this.totalErrors,
    };
  }

  /**
   * Whether the client is enabled and initialized.
   */
  isEnabled(): boolean {
    return this.config.enabled && this.initialized && this.client !== null;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private buildTags(extraTags?: string[]): string[] {
    const tags = [...(this.config.tags ?? [])];
    if (extraTags) tags.push(...extraTags);
    if (this.config.mode) tags.push(`deployment:${this.config.mode}`);
    return [...new Set(tags)];
  }

  private handleError(operation: string, error: unknown): void {
    this.totalErrors++;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Langfuse] ${operation} failed:`, message);
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.warn('[Langfuse] Scheduled flush error:', err);
      });
    }, this.config.flushInterval);

    // Don't keep the process alive for the timer
    if (typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }
}

// ---------------------------------------------------------------------------
// Option interfaces for public methods
// ---------------------------------------------------------------------------

export interface TraceOptions {
  traceId?: string;
  name?: string;
  sessionId?: string;
  userId?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface GenerationOptions {
  id?: string;
  name?: string;
  model: string;
  providerId: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  modelParameters?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  messages?: unknown;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    duration: number;
  };
  metadata?: Record<string, unknown>;
  level?: ObservationLevel;
  parentObservationId?: string;
  completionStartTime?: number;
}

export interface UpdateGenerationOptions {
  output?: unknown;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
  };
  metadata?: Record<string, unknown>;
}

export interface EndGenerationOptions {
  output?: unknown;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    duration?: number;
  };
  metadata?: Record<string, unknown>;
  finishReason?: string;
  startTime?: number;
}

export interface SpanOptions {
  id?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: ObservationLevel;
  parentObservationId?: string;
}

export interface EndSpanOptions {
  name?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: ObservationLevel;
  isError?: boolean;
  errorMessage?: string;
  startTime?: number;
}

export interface EventOptions {
  id?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: ObservationLevel;
  parentObservationId?: string;
}
