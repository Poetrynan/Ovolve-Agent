/**
 * @oa/tracing — Public Exports
 *
 * Langfuse integration layer for OvolveAgent observability.
 * Provides full-chain agent tracing with trace/generation/span/event hierarchy.
 *
 * @example
 * ```ts
 * import { createTracer, createConfig } from '@oa/tracing';
 *
 * const config = createConfig({
 *   publicKey: process.env.LANGFUSE_PUBLIC_KEY,
 *   secretKey: process.env.LANGFUSE_SECRET_KEY,
 * });
 *
 * const tracer = createTracer(config);
 * await tracer.initialize();
 *
 * // Start tracing an agent turn
 * const trace = tracer.startTurn('sess_123', 'Hello, agent!');
 *
 * // Trace an LLM call
 * tracer.traceLlmCall('sess_123', { request, response });
 *
 * // Trace a tool execution
 * tracer.traceToolCall('sess_123', {
 *   toolName: 'read_file',
 *   input: { path: '/foo.txt' },
 *   output: { content: 'Hello' },
 *   startTime: Date.now() - 100,
 *   endTime: Date.now(),
 * });
 *
 * // End the turn
 * tracer.endTurn('sess_123', { output: 'Done', endReason: 'natural_stop' });
 * ```
 */

// =============================================================================
// Factory — Primary entry point
// =============================================================================

export { createTracer } from './factory';

// =============================================================================
// Core classes
// =============================================================================

export { AgentTracer } from './agent-tracer';
export { LangfuseClientWrapper } from './langfuse-client';
export { TracingMiddleware, createMiddleware, createExpressMiddleware } from './middleware';
export {
  TracingConfigBuilder,
  createConfig,
  createConfigUnsafe,
  loadFromEnv,
  loadFromFile,
  validateConfig,
  detectDeploymentMode,
  hasLangfuseCredentials,
  summarizeConfig,
  ConfigValidationError,
} from './config';

// =============================================================================
// Types
// =============================================================================

export type {
  // Config
  TracingConfig,
  LangfuseDeploymentMode,

  // Contexts
  TraceContext,
  GenerationContext,
  GenerationResult,
  SpanContext,
  SpanResult,
  EventContext,
  AgentTurnContext,

  // Options
  TraceLlmCallOptions,
  TraceToolCallOptions,
  AgentDecision,

  // Levels
  ObservationLevel,

  // Middleware
  MiddlewareRequest,
  MiddlewareResponse,
  NextFunction,
  ExpressRequest,
  ExpressResponse,
  ExpressMiddleware,
  IPCCommandContext,
  IPCCommandHandler,
  MiddlewareOptions,

  // Status
  FlushResult,
  TracingHealth,
  TracingEventForwarder,

  // Config file
  TracingConfigFile,
  ConfigSource,
} from './types';

// =============================================================================
// Constants
// =============================================================================

export { DEFAULT_TRACING_CONFIG } from './types';
