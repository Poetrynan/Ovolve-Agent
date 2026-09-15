/**
 * @oa/tracing — Integration Fix
 *
 * Additional exports and type bridges needed by other packages.
 */

export type {
  TracerConfig,
  SpanKind,
  SpanStatus,
  TraceContext,
} from './types';

export { AgentTracer, createAgentTracer } from './factory';
export { LangfuseClient } from './langfuse-client';
