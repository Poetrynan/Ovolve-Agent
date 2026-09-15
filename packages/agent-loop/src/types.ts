/**
 * Core types for the @oa/agent-loop package.
 *
 * Defines the agent loop configuration, session state, events, steering
 * and follow-up messages, and tool execution types.
 */

import type {
  LlmRequest,
  LlmResponse,
  LlmMessage,
  StreamChunk,
  ToolDefinition,
  ToolCall,
  TokenUsage,
  ThinkingLevel,
} from '@oa/llm';

// Re-export LLM types for convenience.
export type {
  LlmRequest,
  LlmResponse,
  LlmMessage,
  StreamChunk,
  ToolDefinition,
  ToolCall,
  TokenUsage,
  ThinkingLevel,
};

// ---------------------------------------------------------------------------
// Agent Loop Configuration
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  /** LLM client instance. */
  llmClient: import('@oa/llm').LlmClient;
  /** Maximum number of agentic steps per turn (default 25). */
  maxSteps: number;
  /** Maximum number of tool calls per step (default 50). */
  maxToolCallsPerStep: number;
  /** Tool execution mode (default 'parallel'). */
  toolExecutionMode: 'parallel' | 'sequential';
  /** Maximum parallel tool executions (default 8). */
  maxParallelTools: number;
  /** Turn timeout in ms (default 600_000 = 10 min). */
  turnTimeout: number;
  /** Default system prompt (base layer). */
  systemPrompt: string;
  /** Whether to inject memory into context. */
  enableMemoryInjection: boolean;
  /** Whether to inject skill metadata into context. */
  enableSkillInjection: boolean;
  /** Event handler for all agent events. */
  onEvent?: (event: AgentEvent) => void;
  /** Custom logger. */
  logger?: Logger;
}

export interface Logger {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
}

// ---------------------------------------------------------------------------
// Turn & Session
// ---------------------------------------------------------------------------

export interface TurnOptions {
  /** User's message / input. */
  userMessage: string;
  /** Optional system prompt override for this turn. */
  systemPromptOverride?: string;
  /** Optional model override. */
  modelOverride?: string;
  /** Optional temperature override. */
  temperatureOverride?: number;
  /** Optional max tokens override. */
  maxTokensOverride?: number;
  /** Optional thinking level override. */
  thinkingOverride?: ThinkingLevel;
  /** Specific tool names to make available (all if undefined). */
  toolFilter?: string[];
  /** Additional context to inject. */
  additionalContext?: Record<string, unknown>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface SessionState {
  id: string;
  messages: LlmMessage[];
  status: SessionStatus;
  currentStep: number;
  toolCallsThisStep: number;
  startTime: number;
  lastActivity: number;
  /** Steering messages waiting to be injected. */
  steeringQueue: SteeringMessage[];
  /** Follow-up messages queued after natural stop. */
  followUpQueue: FollowUpMessage[];
  /** Currently active abort controller. */
  abortController: AbortController | null;
  /** Whether the session is paused. */
  paused: boolean;
  /** Pause resume resolver. */
  pauseResume?: (() => void) | null;
  /** Cumulative token usage this session. */
  usage: TokenUsage;
  /** Metadata. */
  metadata: Record<string, unknown>;
}

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'waiting_for_tool'
  | 'stopped'
  | 'completed'
  | 'error';

// ---------------------------------------------------------------------------
// Steering & Follow-up
// ---------------------------------------------------------------------------

export interface SteeringMessage {
  id: string;
  sessionId: string;
  /** The instruction to inject. */
  instruction: string;
  /** Priority (high interrupts immediately). */
  priority: 'high' | 'normal';
  /** When the steering was created. */
  timestamp: number;
}

export interface FollowUpMessage {
  id: string;
  sessionId: string;
  /** The message to inject after natural stop. */
  message: string;
  /** Optional condition for when to inject. */
  condition?: string;
  /** Delay in ms before injecting. */
  delay: number;
  /** When the follow-up was created. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Tool Execution
// ---------------------------------------------------------------------------

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  duration: number;
  metadata?: Record<string, unknown>;
}

export type ToolExecutionMode = 'parallel' | 'sequential';

export interface ToolExecutionContext {
  /** Tool call to execute. */
  toolCall: ToolCall;
  /** Current session state. */
  session: SessionState;
  /** Signal for cancellation. */
  signal?: AbortSignal;
  /** Available tool definitions. */
  toolDefs: ToolDefinition[];
}

// ---------------------------------------------------------------------------
// Step State
// ---------------------------------------------------------------------------

export interface StepResult {
  stepNumber: number;
  response: LlmResponse;
  toolResults: ToolResult[];
  duration: number;
  /** Whether the agent naturally stopped (no more tool calls). */
  naturalStop: boolean;
}

export interface TurnResult {
  sessionId: string;
  steps: StepResult[];
  totalDuration: number;
  finalMessage: string;
  usage: TokenUsage;
  /** Reason the turn ended. */
  endReason: TurnEndReason;
}

export type TurnEndReason =
  | 'natural_stop'
  | 'max_steps_reached'
  | 'timeout'
  | 'stopped'
  | 'error'
  | 'follow_up';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AgentEventType =
  | 'agent:turn_start'
  | 'agent:turn_end'
  | 'agent:step_start'
  | 'agent:step_end'
  | 'agent:llm_start'
  | 'agent:llm_chunk'
  | 'agent:llm_end'
  | 'agent:tool_start'
  | 'agent:tool_end'
  | 'agent:tool_error'
  | 'agent:steering_received'
  | 'agent:steering_injected'
  | 'agent:followup_queued'
  | 'agent:followup_injected'
  | 'agent:paused'
  | 'agent:resumed'
  | 'agent:stopped'
  | 'agent:error'
  | 'agent:thinking'
  | 'agent:context_assembled';

export type AgentEvent =
  | { type: 'agent:turn_start'; sessionId: string; timestamp: number; data: { userMessage: string } }
  | { type: 'agent:turn_end'; sessionId: string; timestamp: number; data: TurnResult }
  | { type: 'agent:step_start'; sessionId: string; timestamp: number; data: { step: number } }
  | { type: 'agent:step_end'; sessionId: string; timestamp: number; data: StepResult }
  | { type: 'agent:llm_start'; sessionId: string; timestamp: number; data: { step: number } }
  | { type: 'agent:llm_chunk'; sessionId: string; timestamp: number; data: { chunk: StreamChunk } }
  | { type: 'agent:llm_end'; sessionId: string; timestamp: number; data: { response: LlmResponse } }
  | { type: 'agent:tool_start'; sessionId: string; timestamp: number; data: { toolCall: ToolCall } }
  | { type: 'agent:tool_end'; sessionId: string; timestamp: number; data: ToolResult }
  | { type: 'agent:tool_error'; sessionId: string; timestamp: number; data: { toolCall: ToolCall; error: Error } }
  | { type: 'agent:steering_received'; sessionId: string; timestamp: number; data: SteeringMessage }
  | { type: 'agent:steering_injected'; sessionId: string; timestamp: number; data: SteeringMessage }
  | { type: 'agent:followup_queued'; sessionId: string; timestamp: number; data: FollowUpMessage }
  | { type: 'agent:followup_injected'; sessionId: string; timestamp: number; data: FollowUpMessage }
  | { type: 'agent:paused'; sessionId: string; timestamp: number; data: { step: number } }
  | { type: 'agent:resumed'; sessionId: string; timestamp: number; data: { step: number } }
  | { type: 'agent:stopped'; sessionId: string; timestamp: number; data: { step: number } }
  | { type: 'agent:error'; sessionId: string; timestamp: number; data: { error: Error; step?: number } }
  | { type: 'agent:thinking'; sessionId: string; timestamp: number; data: { content: string } }
  | { type: 'agent:context_assembled'; sessionId: string; timestamp: number; data: { request: LlmRequest } };

// ---------------------------------------------------------------------------
// Context Assembly
// ---------------------------------------------------------------------------

export interface SystemPromptLayer {
  id: string;
  priority: number;
  content: string;
}

export interface ContextAssemblyResult {
  systemPrompt: string;
  messages: LlmMessage[];
  tools: ToolDefinition[];
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Memory & Skills
// ---------------------------------------------------------------------------

export interface MemoryItem {
  id: string;
  content: string;
  type: 'fact' | 'preference' | 'context' | 'instruction';
  relevance: number;
  timestamp: number;
}

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  instructions?: string;
  parameters?: Record<string, unknown>;
}
