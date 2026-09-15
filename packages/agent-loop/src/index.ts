/**
 * @oa/agent-loop — Event-driven agent loop with multi-step reasoning.
 *
 * Implements a 5-step decision chain (Perceive, Think, Act, Observe, Decide)
 * with support for steering, pause/resume, and follow-up message injection.
 */

// Main agent loop
export { AgentLoop } from './agent-loop.js';

// Step executor
export { executeStep } from './step-executor.js';
export type { StepExecutorConfig } from './step-executor.js';

// Context assembler
export { assembleContext, createContextAssembler } from './context-assembler.js';
export type { ContextAssemblerConfig } from './context-assembler.js';

// Stream handler
export { StreamHandler, createStreamHandler } from './stream-handler.js';
export type { StreamHandlerResult, StreamHandlerOptions } from './stream-handler.js';

// Types
export type {
  AgentLoopConfig,
  Logger,
  TurnOptions,
  SessionState,
  SessionStatus,
  SteeringMessage,
  FollowUpMessage,
  ToolResult,
  ToolExecutionMode,
  ToolExecutionContext,
  StepResult,
  TurnResult,
  TurnEndReason,
  AgentEvent,
  AgentEventType,
  SystemPromptLayer,
  ContextAssemblyResult,
  MemoryItem,
  SkillMetadata,
} from './types.js';

// Re-export LLM types for convenience
export type {
  LlmRequest,
  LlmResponse,
  LlmMessage,
  StreamChunk,
  ToolDefinition,
  ToolCall,
  TokenUsage,
  ThinkingLevel,
} from '@oa/llm';

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

import { AgentLoop } from './agent-loop.js';
import type { AgentLoopConfig } from './types.js';

/**
 * Create an AgentLoop instance with the given configuration.
 */
export function createAgentLoop(config: AgentLoopConfig): AgentLoop {
  return new AgentLoop(config);
}
