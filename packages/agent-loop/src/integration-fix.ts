/**
 * @oa/agent-loop — Integration Fix
 *
 * Additional exports and type bridges needed by other packages.
 * Ensures interface alignment across the monorepo.
 */

import type {
  AgentLoopConfig,
  SessionState,
  TurnOptions,
  StepResult,
  TurnResult,
  ToolResult,
  AgentEvent,
} from './types';

// ---------------------------------------------------------------------------
// Re-exports for cross-package compatibility
// ---------------------------------------------------------------------------

export type {
  AgentLoopConfig,
  SessionState,
  TurnOptions,
  StepResult,
  TurnResult,
  ToolResult,
  AgentEvent,
};

// ---------------------------------------------------------------------------
// AgentLoopConfig helpers
// ---------------------------------------------------------------------------

/**
 * Default AgentLoopConfig values.
 */
export const DEFAULT_AGENT_LOOP_CONFIG: Partial<AgentLoopConfig> = {
  maxSteps: 25,
  maxToolCallsPerStep: 50,
  toolExecutionMode: 'parallel',
  maxParallelTools: 8,
  turnTimeout: 600_000,
  systemPrompt: 'You are OvolveAgent, a helpful AI assistant.',
  enableMemoryInjection: true,
  enableSkillInjection: true,
};

/**
 * Create a partial AgentLoopConfig with sensible defaults.
 * Only required fields need to be provided.
 */
export function createAgentLoopConfig(
  required: Pick<AgentLoopConfig, 'llmClient' | 'systemPrompt'>,
  overrides?: Partial<AgentLoopConfig>
): AgentLoopConfig {
  return {
    ...DEFAULT_AGENT_LOOP_CONFIG,
    ...required,
    ...overrides,
  } as AgentLoopConfig;
}

// ---------------------------------------------------------------------------
// SessionState helpers
// ---------------------------------------------------------------------------

/**
 * Create initial session state.
 */
export function createInitialSessionState(id: string): SessionState {
  const now = Date.now();
  return {
    id,
    messages: [],
    status: 'idle',
    currentStep: 0,
    toolCallsThisStep: 0,
    startTime: now,
    lastActivity: now,
    steeringQueue: [],
    followUpQueue: [],
    abortController: null,
    paused: false,
    pauseResume: null,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cost: 0,
      duration: 0,
    },
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// ToolResult bridges
// ---------------------------------------------------------------------------

/**
 * Convert agent-loop ToolResult to LLM-compatible tool result content block.
 */
export function toLlmToolResult(result: ToolResult): {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
} {
  return {
    type: 'tool_result',
    toolUseId: result.toolCallId,
    content: result.content,
    isError: result.isError,
  };
}

/**
 * Convert agent-loop ToolResult to tools package ToolResult format.
 */
export function toToolsPackageResult(result: ToolResult): {
  success: boolean;
  content: Array<{ type: 'text'; text: string } | { type: 'error'; message: string }>;
  metadata: { toolName: string; durationMs: number; retryCount: number; truncated: boolean };
} {
  return {
    success: !result.isError,
    content: result.isError
      ? [{ type: 'error', message: result.content }]
      : [{ type: 'text', text: result.content }],
    metadata: {
      toolName: result.toolName,
      durationMs: result.duration,
      retryCount: 0,
      truncated: false,
      extra: result.metadata,
    },
  };
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

/**
 * Create an agent event with the current timestamp.
 */
export function createAgentEvent<T extends AgentEvent['type']>(
  type: T,
  sessionId: string,
  data: Extract<AgentEvent, { type: T }> extends { data: infer D } ? D : never
): Extract<AgentEvent, { type: T }> {
  return {
    type,
    sessionId,
    timestamp: Date.now(),
    data,
  } as Extract<AgentEvent, { type: T }>;
}

// ---------------------------------------------------------------------------
// Turn result helpers
// ---------------------------------------------------------------------------

/**
 * Create a TurnResult with default values.
 */
export function createTurnResult(
  sessionId: string,
  overrides?: Partial<TurnResult>
): TurnResult {
  return {
    sessionId,
    steps: [],
    totalDuration: 0,
    finalMessage: '',
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cost: 0,
      duration: 0,
    },
    endReason: 'natural_stop',
    ...overrides,
  };
}
