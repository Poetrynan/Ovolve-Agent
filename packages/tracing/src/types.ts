/**
 * @oa/tracing — Core Types
 *
 * Langfuse integration types for OvolveAgent observability.
 * Defines tracing configuration, trace/span/generation contexts,
 * and agent-tracing abstractions.
 *
 * Trace hierarchy:
 *   Trace (one agent turn)
 *     ├── Generation (one LLM call)
 *     │     ├── Span (tool execution within LLM context)
 *     │     └── Event (custom: fold, memory, security)
 *     └── Span (standalone tool execution)
 */

import type { LlmRequest, LlmResponse, TokenUsage, ToolCall } from '@oa/llm';
import type { AgentEvent } from '@oa/event-store';

// ---------------------------------------------------------------------------
// Langfuse deployment modes
// ---------------------------------------------------------------------------

export type LangfuseDeploymentMode = 'cloud' | 'self-hosted';

// ---------------------------------------------------------------------------
// TracingConfig — Full configuration for the tracing subsystem
// ---------------------------------------------------------------------------

export interface TracingConfig {
  /** Langfuse deployment mode. */
  mode: LangfuseDeploymentMode;
  /** Langfuse public key (pk-lf-...). */
  publicKey: string;
  /** Langfuse secret key (sk-lf-...). */
  secretKey: string;
  /**
   * Langfuse base URL.
   * - Cloud: https://cloud.langfuse.com (default)
   * - Self-hosted: your instance URL
   */
  baseUrl: string;
  /** Whether tracing is enabled (default: true). */
  enabled: boolean;
  /** Flush interval in ms (default: 10_000). */
  flushInterval: number;
  /** Maximum number of events to batch before flush (default: 50). */
  batchSize: number;
  /** Request timeout in ms (default: 10_000). */
  requestTimeout: number;
  /** Number of retries for failed requests (default: 3). */
  maxRetries: number;
  /** Release identifier (git commit, semver, etc.) for filtering in Langfuse. */
  release?: string;
  /** Custom tags applied to every trace. */
  tags?: string[];
  /** Whether to enable debug logging (default: false). */
  debug: boolean;
  /** Custom fields added to every trace's metadata. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TraceContext — Represents an active agent-turn trace
// ---------------------------------------------------------------------------

export interface TraceContext {
  /** Langfuse trace ID. */
  traceId: string;
  /** Internal session ID this trace belongs to. */
  sessionId: string;
  /** Human-readable trace name. */
  name: string;
  /** When the trace started (ms since epoch). */
  startTime: number;
  /** User ID (if available). */
  userId?: string;
  /** User message that initiated this turn. */
  input?: unknown;
  /** Custom tags. */
  tags: string[];
  /** Additional metadata. */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GenerationContext — Represents an LLM call within a trace
// ---------------------------------------------------------------------------

export interface GenerationContext {
  /** Langfuse generation/observation ID. */
  id: string;
  /** Parent trace ID. */
  traceId: string;
  /** Model used. */
  model: string;
  /** Provider ID. */
  providerId: string;
  /** The LLM request. */
  request: LlmRequest;
  /** Start time (ms since epoch). */
  startTime: number;
}

export interface GenerationResult {
  /** Langfuse observation ID. */
  id: string;
  /** Parent trace ID. */
  traceId: string;
  /** The LLM response. */
  response: LlmResponse;
  /** End time (ms since epoch). */
  endTime: number;
}

// ---------------------------------------------------------------------------
// SpanContext — Represents a tool execution within a trace
// ---------------------------------------------------------------------------

export interface SpanContext {
  /** Langfuse span/observation ID. */
  id: string;
  /** Parent trace ID. */
  traceId: string;
  /** Optional parent observation ID (for nesting). */
  parentId?: string;
  /** Span name. */
  name: string;
  /** Span level (default: 'DEFAULT'). */
  level: ObservationLevel;
  /** Start time (ms since epoch). */
  startTime: number;
}

export interface SpanResult {
  /** Langfuse observation ID. */
  id: string;
  /** Parent trace ID. */
  traceId: string;
  /** Tool name (if tool span). */
  toolName?: string;
  /** Input arguments. */
  input?: unknown;
  /** Output / result. */
  output?: unknown;
  /** End time (ms since epoch). */
  endTime: number;
  /** Whether the span ended with an error. */
  isError: boolean;
  /** Error message (if any). */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// EventContext — Custom events (fold, memory, security)
// ---------------------------------------------------------------------------

export interface EventContext {
  /** Langfuse event/observation ID. */
  id: string;
  /** Parent trace ID. */
  traceId: string;
  /** Optional parent observation ID. */
  parentId?: string;
  /** Event name. */
  name: string;
  /** Event level. */
  level: ObservationLevel;
  /** Event timestamp (ms since epoch). */
  timestamp: number;
  /** Input to the event. */
  input?: unknown;
  /** Output from the event. */
  output?: unknown;
  /** Metadata. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Observation levels (mirrors Langfuse levels)
// ---------------------------------------------------------------------------

export type ObservationLevel =
  | 'DEBUG'
  | 'DEFAULT'
  | 'WARNING'
  | 'ERROR';

// ---------------------------------------------------------------------------
// AgentTracer — High-level tracing operations
// ---------------------------------------------------------------------------

export interface AgentTurnContext {
  /** Session ID. */
  sessionId: string;
  /** The Langfuse trace ID. */
  traceId: string;
  /** Turn start time (ms since epoch). */
  startTime: number;
  /** Map of active generation IDs by a correlation key. */
  activeGenerations: Map<string, string>;
  /** Map of active span IDs by a correlation key. */
  activeSpans: Map<string, string>;
  /** Whether the turn is still active. */
  active: boolean;
}

// ---------------------------------------------------------------------------
// LLM call tracing options
// ---------------------------------------------------------------------------

export interface TraceLlmCallOptions {
  /** LLM request. */
  request: LlmRequest;
  /** LLM response. */
  response: LlmResponse;
  /** Correlation key to match request → response (defaults to response.id). */
  correlationKey?: string;
  /** Start time override (defaults to response-derived time). */
  startTime?: number;
  /** End time override. */
  endTime?: number;
}

// ---------------------------------------------------------------------------
// Tool call tracing options
// ---------------------------------------------------------------------------

export interface TraceToolCallOptions {
  /** Tool name. */
  toolName: string;
  /** Tool input arguments. */
  input: unknown;
  /** Tool output / result. */
  output?: unknown;
  /** Whether the tool call errored. */
  isError?: boolean;
  /** Error message. */
  errorMessage?: string;
  /** Start time (ms since epoch). */
  startTime: number;
  /** End time (ms since epoch). */
  endTime: number;
  /** Tool call ID from the LLM (if part of a generation). */
  toolCallId?: string;
  /** Correlation key linking to a generation. */
  correlationKey?: string;
}

// ---------------------------------------------------------------------------
// Agent decision tracing
// ---------------------------------------------------------------------------

export interface AgentDecision {
  /** The decision type. */
  type: 'reasoning' | 'context_assembled' | 'tool_selection' | 'stop' | 'error';
  /** Human-readable summary. */
  summary: string;
  /** Detailed reasoning. */
  reasoning?: string;
  /** Associated metadata. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Middleware types
// ---------------------------------------------------------------------------

export interface MiddlewareRequest {
  /** Request ID. */
  requestId: string;
  /** HTTP method. */
  method: string;
  /** Request URL path. */
  url: string;
  /** Request headers. */
  headers: Record<string, string>;
  /** Request body (parsed). */
  body?: unknown;
  /** Session ID (if available). */
  sessionId?: string;
  /** Timestamp. */
  timestamp: number;
}

export interface MiddlewareResponse {
  /** HTTP status code. */
  statusCode: number;
  /** Response body. */
  body?: unknown;
  /** Response time in ms. */
  duration: number;
}

export type NextFunction = () => Promise<void> | void;

// ---------------------------------------------------------------------------
// Flush & shutdown status
// ---------------------------------------------------------------------------

export interface FlushResult {
  /** Whether flush succeeded. */
  success: boolean;
  /** Number of events flushed. */
  eventsFlushed: number;
  /** Error message if flush failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Event forwarding from EventStore
// ---------------------------------------------------------------------------

export interface TracingEventForwarder {
  /** Forward an agent event to Langfuse. */
  forward(event: AgentEvent): Promise<void>;
  /** Batch forward multiple events. */
  forwardBatch(events: AgentEvent[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Status & health
// ---------------------------------------------------------------------------

export interface TracingHealth {
  /** Whether the Langfuse client is initialized. */
  initialized: boolean;
  /** Whether the last flush succeeded. */
  lastFlushSuccess: boolean;
  /** Last flush timestamp (ms since epoch). */
  lastFlushTime?: number;
  /** Number of pending events. */
  pendingEvents: number;
  /** Total events sent this session. */
  totalEventsSent: number;
  /** Total errors encountered. */
  totalErrors: number;
}

// ---------------------------------------------------------------------------
// Default config values
// ---------------------------------------------------------------------------

export const DEFAULT_TRACING_CONFIG: Partial<TracingConfig> = {
  enabled: true,
  baseUrl: 'https://cloud.langfuse.com',
  flushInterval: 10_000,
  batchSize: 50,
  requestTimeout: 10_000,
  maxRetries: 3,
  debug: false,
};
