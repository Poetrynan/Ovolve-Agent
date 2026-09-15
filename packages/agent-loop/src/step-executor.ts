/**
 * Single step execution for the agent loop.
 *
 * Each step: assembles context, streams LLM response, parses tool calls,
 * executes them (parallel or sequential), and returns the step result.
 */

import { v4 as uuid } from 'uuid';
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  StreamChunk,
  ToolDefinition,
  ToolCall,
  ToolChoice,
} from '@oa/llm';
import type {
  SessionState,
  StepResult,
  ToolResult,
  AgentEvent,
  SteeringMessage,
  ThinkingLevel,
  TurnOptions,
} from './types.js';
import { createStreamHandler } from './stream-handler.js';
import { assembleContext, ContextAssemblerConfig } from './context-assembler.js';

export interface StepExecutorConfig {
  llmClient: LlmClient;
  contextConfig: ContextAssemblerConfig;
  /** Tool execution function provided by the caller. */
  executeTool: (
    toolCall: ToolCall,
    toolDefs: ToolDefinition[],
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  /** Bounded parallel pool size. */
  maxParallelTools: number;
  /** Tool execution mode. */
  toolExecutionMode: 'parallel' | 'sequential';
  /** Event handler. */
  onEvent?: (event: AgentEvent) => void;
  /** Logger. */
  logger?: { debug: (msg: string, data?: unknown) => void; error: (msg: string, data?: unknown) => void };
}

/**
 * Execute a single agentic step.
 */
export async function executeStep(
  session: SessionState,
  config: StepExecutorConfig,
  options: TurnOptions,
): Promise<StepResult> {
  const startTime = Date.now();
  const stepNumber = session.currentStep;

  config.onEvent?.({
    type: 'agent:step_start',
    sessionId: session.id,
    timestamp: Date.now(),
    data: { step: stepNumber },
  });

  config.onEvent?.({
    type: 'agent:llm_start',
    sessionId: session.id,
    timestamp: Date.now(),
    data: { step: stepNumber },
  });

  // 1. Assemble context (LLM request from session state).
  const context = await assembleContext(session, config.contextConfig, {
    model: options.modelOverride ?? 'gpt-4o',
    temperature: options.temperatureOverride ?? 0.7,
    maxTokens: options.maxTokensOverride ?? 16_008,
    thinking: options.thinkingOverride,
    systemPromptOverride: options.systemPromptOverride,
    toolFilter: options.toolFilter,
  });

  // 2. Check for steering messages and inject before LLM call.
  const steering = consumeSteering(session);
  if (steering) {
    context.messages.push({
      role: 'user',
      content: `[STEERING INSTRUCTION - ${steering.priority.toUpperCase()}]: ${steering.instruction}`,
    });

    config.onEvent?.({
      type: 'agent:steering_injected',
      sessionId: session.id,
      timestamp: Date.now(),
      data: steering,
    });
  }

  // 3. Build LLM request.
  const request: LlmRequest = {
    messages: context.messages,
    model: context.metadata.model as string,
    temperature: context.metadata.temperature as number,
    maxTokens: context.metadata.maxTokens as number,
    thinking: context.metadata.thinking as ThinkingLevel | undefined,
    tools: context.tools.length > 0 ? context.tools : undefined,
    toolChoice: context.tools.length > 0 ? 'auto' : undefined,
    metadata: {
      sessionId: session.id,
      step: stepNumber,
    },
    signal: session.abortController?.signal,
  };

  // 4. Stream the LLM response.
  const streamHandler = createStreamHandler({
    onEvent: config.onEvent,
    sessionId: session.id,
  });

  const stream = config.llmClient.stream(request);

  for await (const chunk of stream) {
    // Check for pause.
    await checkPause(session);

    // Check for stop.
    if (session.status === 'stopped') {
      throw new Error('Session stopped');
    }

    streamHandler.processChunk(chunk);

    config.onEvent?.({
      type: 'agent:llm_chunk',
      sessionId: session.id,
      timestamp: Date.now(),
      data: { chunk },
    });
  }

  const streamResult = streamHandler.finalize();

  // Build LlmResponse from stream result.
  const response: LlmResponse = {
    id: `resp_${uuid()}`,
    model: context.metadata.model as string,
    providerId: '',
    message: streamResult.message,
    toolCalls: streamResult.toolCalls,
    usage: streamResult.usage,
    finishReason: streamResult.toolCalls.length > 0 ? 'tool_calls' : 'stop',
    reasoning: streamResult.reasoning,
  };

  config.onEvent?.({
    type: 'agent:llm_end',
    sessionId: session.id,
    timestamp: Date.now(),
    data: { response },
  });

  // 5. Execute tool calls if any.
  const toolResults: ToolResult[] = [];
  if (streamResult.toolCalls.length > 0) {
    const results = await executeToolCalls(
      session,
      streamResult.toolCalls,
      context.tools,
      config,
    );
    toolResults.push(...results);
  }

  // 6. Update session state.
  session.messages.push(streamResult.message);

  for (const result of toolResults) {
    session.messages.push({
      role: 'tool',
      toolCallId: result.toolCallId,
      content: result.content,
      name: result.toolName,
    });
  }

  const duration = Date.now() - startTime;
  const naturalStop = streamResult.toolCalls.length === 0;

  const stepResult: StepResult = {
    stepNumber,
    response,
    toolResults,
    duration,
    naturalStop,
  };

  config.onEvent?.({
    type: 'agent:step_end',
    sessionId: session.id,
    timestamp: Date.now(),
    data: stepResult,
  });

  return stepResult;
}

/**
 * Execute tool calls (parallel or sequential).
 */
async function executeToolCalls(
  session: SessionState,
  toolCalls: ToolCall[],
  toolDefs: ToolDefinition[],
  config: StepExecutorConfig,
): Promise<ToolResult[]> {
  if (config.toolExecutionMode === 'sequential') {
    return executeSequential(session, toolCalls, toolDefs, config);
  }
  return executeParallel(session, toolCalls, toolDefs, config);
}

/**
 * Execute tool calls sequentially (one at a time).
 */
async function executeSequential(
  session: SessionState,
  toolCalls: ToolCall[],
  toolDefs: ToolDefinition[],
  config: StepExecutorConfig,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const toolCall of toolCalls) {
    // Check for pause/stop before each tool.
    await checkPause(session);
    if (session.status === 'stopped') break;

    const result = await runSingleTool(session, toolCall, toolDefs, config);
    results.push(result);
  }

  return results;
}

/**
 * Execute tool calls in parallel with bounded pool.
 */
async function executeParallel(
  session: SessionState,
  toolCalls: ToolCall[],
  toolDefs: ToolDefinition[],
  config: StepExecutorConfig,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  const queue = [...toolCalls];
  const executing: Promise<void>[] = [];

  // Worker function that processes tools from the queue.
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      // Check for pause/stop.
      await checkPause(session);
      if (session.status === 'stopped') break;

      const toolCall = queue.shift();
      if (!toolCall) break;

      const result = await runSingleTool(session, toolCall, toolDefs, config);
      results.push(result);
    }
  };

  // Start workers (bounded by maxParallelTools).
  const numWorkers = Math.min(config.maxParallelTools, toolCalls.length);
  for (let i = 0; i < numWorkers; i++) {
    executing.push(worker());
  }

  await Promise.all(executing);
  return results;
}

/**
 * Run a single tool call.
 */
async function runSingleTool(
  session: SessionState,
  toolCall: ToolCall,
  toolDefs: ToolDefinition[],
  config: StepExecutorConfig,
): Promise<ToolResult> {
  const startTime = Date.now();

  config.onEvent?.({
    type: 'agent:tool_start',
    sessionId: session.id,
    timestamp: Date.now(),
    data: { toolCall },
  });

  try {
    const result = await config.executeTool(toolCall, toolDefs, session.abortController?.signal);

    config.onEvent?.({
      type: 'agent:tool_end',
      sessionId: session.id,
      timestamp: Date.now(),
      data: result,
    });

    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const duration = Date.now() - startTime;

    const result: ToolResult = {
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      content: `Error: ${error.message}`,
      isError: true,
      duration,
    };

    config.onEvent?.({
      type: 'agent:tool_error',
      sessionId: session.id,
      timestamp: Date.now(),
      data: { toolCall, error },
    });

    return result;
  }
}

/**
 * Consume the highest-priority steering message from the queue.
 */
function consumeSteering(session: SessionState): SteeringMessage | null {
  if (session.steeringQueue.length === 0) return null;

  // Sort by priority (high first) then by timestamp (oldest first).
  session.steeringQueue.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority === 'high' ? -1 : 1;
    }
    return a.timestamp - b.timestamp;
  });

  return session.steeringQueue.shift() ?? null;
}

/**
 * Check if the session is paused and wait for resume.
 */
async function checkPause(session: SessionState): Promise<void> {
  if (!session.paused) return;

  return new Promise<void>((resolve) => {
    session.pauseResume = () => {
      session.pauseResume = null;
      resolve();
    };
  });
}
