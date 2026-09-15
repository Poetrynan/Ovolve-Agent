/**
 * @oa/tools — Tool Execution Pipeline
 *
 * Orchestrates tool execution through a series of stages:
 * 1. Pre-execute hooks (waterfall)
 * 2. Guard checks
 * 3. Actual execution (with timeout & retry)
 * 4. Post-execute hooks (waterfall)
 * 5. Result finalization
 */

import {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  ToolCall,
  ToolCallStatus,
  ToolHook,
  ToolGuard,
  DispatchOptions,
  DispatchResult,
} from './types';
import { createErrorResult, generateCallId } from './tool-definition';

/**
 * Pipeline stage names for diagnostics.
 */
enum PipelineStage {
  PRE_EXECUTE = 'PRE_EXECUTE',
  GUARD = 'GUARD',
  EXECUTE = 'EXECUTE',
  POST_EXECUTE = 'POST_EXECUTE',
  FINALIZE = 'FINALIZE',
}

/**
 * Error thrown during pipeline execution.
 */
export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly stage: PipelineStage,
    public readonly toolName: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

/**
 * The execution pipeline manages the full lifecycle of a single tool call.
 */
export class ExecutionPipeline {
  private preExecuteHooks: Array<{ hook: ToolHook; priority: number }> = [];
  private postExecuteHooks: Array<{ hook: ToolHook; priority: number }> = [];
  private guards: Array<{ guard: ToolGuard; priority: number }> = [];

  /**
   * Add a pre-execute hook. Receives args, can modify them.
   */
  addPreExecuteHook(hook: ToolHook, priority = 100): void {
    this.preExecuteHooks.push({ hook, priority });
    this.preExecuteHooks.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Add a post-execute hook. Receives result, can modify it.
   */
  addPostExecuteHook(hook: ToolHook, priority = 100): void {
    this.postExecuteHooks.push({ hook, priority });
    this.postExecuteHooks.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Add a guard check. Can prevent execution.
   */
  addGuard(guard: ToolGuard, priority = 100): void {
    this.guards.push({ guard, priority });
    this.guards.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Remove a pre-execute hook.
   */
  removePreExecuteHook(hook: ToolHook): void {
    this.preExecuteHooks = this.preExecuteHooks.filter((h) => h.hook !== hook);
  }

  /**
   * Remove a post-execute hook.
   */
  removePostExecuteHook(hook: ToolHook): void {
    this.postExecuteHooks = this.postExecuteHooks.filter((h) => h.hook !== hook);
  }

  /**
   * Remove a guard.
   */
  removeGuard(guard: ToolGuard): void {
    this.guards = this.guards.filter((g) => g.guard !== guard);
  }

  /**
   * Execute a tool through the full pipeline.
   */
  async execute(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    options: DispatchOptions = {}
  ): Promise<DispatchResult> {
    const callId = generateCallId();
    const startTime = Date.now();

    const call: ToolCall = {
      id: callId,
      name: definition.name,
      args,
      timestamp: new Date(),
      status: ToolCallStatus.PENDING,
      context: {
        depth: context.depth,
        parentCallId: context.parentCallId,
      },
    };

    let currentArgs = { ...args };
    let result: ToolResult;

    try {
      // ─── Stage 1: Pre-execute hooks ─────────────────────────────
      if (!options.skipHooks) {
        const preResult = await this.runPreExecuteHooks(definition, currentArgs, context);
        if (preResult.blocked) {
          call.status = ToolCallStatus.BLOCKED;
          result = createErrorResult(
            'GUARD_BLOCKED',
            preResult.reason ?? 'Execution blocked by pre-execute hook',
            false,
            {},
            { toolName: definition.name, durationMs: Date.now() - startTime }
          );
          return { call, result };
        }
        currentArgs = preResult.args;
      }

      // ─── Stage 2: Guard checks ──────────────────────────────────
      const guardResult = await this.runGuards(definition, currentArgs, context);
      if (!guardResult.allowed) {
        call.status = ToolCallStatus.BLOCKED;
        result = createErrorResult(
          'GUARD_BLOCKED',
          guardResult.reason ?? 'Execution blocked by guard',
          false,
          {},
          { toolName: definition.name, durationMs: Date.now() - startTime }
        );
        return { call, result };
      }

      // ─── Stage 3: Execute ───────────────────────────────────────
      call.status = ToolCallStatus.EXECUTING;
      const execResult = await this.runExecution(definition, currentArgs, context, options);
      result = execResult;

      // ─── Stage 4: Post-execute hooks ────────────────────────────
      if (!options.skipHooks) {
        result = await this.runPostExecuteHooks(definition, result, context);
      }

      // ─── Stage 5: Finalize ──────────────────────────────────────
      call.status = result.success ? ToolCallStatus.COMPLETED : ToolCallStatus.FAILED;

      return { call, result };
    } catch (err) {
      call.status = ToolCallStatus.FAILED;
      const errorMessage = err instanceof Error ? err.message : String(err);
      result = createErrorResult(
        'PIPELINE_ERROR',
        errorMessage,
        false,
        { stage: PipelineStage.EXECUTE },
        { toolName: definition.name, durationMs: Date.now() - startTime }
      );
      return { call, result };
    }
  }

  /**
   * Run pre-execute hooks in priority order.
   * Each hook can modify the args.
   */
  private async runPreExecuteHooks(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<{ blocked: boolean; reason?: string; args: Record<string, unknown> }> {
    let currentArgs = args;

    for (const { hook } of this.preExecuteHooks) {
      try {
        const result = await hook(definition, currentArgs, context);
        if (result && typeof result === 'object') {
          if ('blocked' in result && (result as { blocked: boolean }).blocked) {
            return {
              blocked: true,
              reason: (result as { reason?: string }).reason,
              args: currentArgs,
            };
          }
          if ('args' in result) {
            currentArgs = (result as { args: Record<string, unknown> }).args;
          }
        }
      } catch (err) {
        throw new PipelineError(
          `Pre-execute hook error: ${err instanceof Error ? err.message : String(err)}`,
          PipelineStage.PRE_EXECUTE,
          definition.name,
          err instanceof Error ? err : undefined
        );
      }
    }

    return { blocked: false, args: currentArgs };
  }

  /**
   * Run guard checks in priority order.
   */
  private async runGuards(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<{ allowed: boolean; reason?: string }> {
    for (const { guard } of this.guards) {
      try {
        const allowed = await guard(definition, args, context);
        if (!allowed) {
          return { allowed: false, reason: 'Guard check failed' };
        }
      } catch (err) {
        throw new PipelineError(
          `Guard error: ${err instanceof Error ? err.message : String(err)}`,
          PipelineStage.GUARD,
          definition.name,
          err instanceof Error ? err : undefined
        );
      }
    }

    return { allowed: true };
  }

  /**
   * Run the actual tool execution with timeout and retry logic.
   */
  private async runExecution(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    options: DispatchOptions
  ): Promise<ToolResult> {
    const timeoutMs = options.timeoutMs ?? definition.timeoutMs;
    let lastError: Error | undefined;
    let retryCount = 0;
    const maxAttempts = definition.retryable ? definition.maxRetries + 1 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.executeWithTimeout(definition, args, context, timeoutMs, options);
        // Update retry count in metadata.
        return {
          ...result,
          metadata: {
            ...result.metadata,
            retryCount,
            toolName: definition.name,
          },
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        retryCount++;

        if (attempt < maxAttempts - 1) {
          // Exponential backoff.
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
          await sleep(backoffMs);
        }
      }
    }

    // All retries exhausted.
    return createErrorResult(
      'EXECUTION_FAILED',
      lastError?.message ?? 'Tool execution failed',
      false,
      { attempts: maxAttempts },
      { toolName: definition.name, retryCount: maxAttempts - 1 }
    );
  }

  /**
   * Execute with a timeout.
   */
  private executeWithTimeout(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    timeoutMs: number,
    options: DispatchOptions
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Tool "${definition.name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Merge abort signals.
      const abortHandler = () => {
        clearTimeout(timeoutId);
        reject(new Error(`Tool "${definition.name}" was cancelled`));
      };

      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timeoutId);
          reject(new Error('Operation was already cancelled'));
          return;
        }
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }

      if (context.signal) {
        if (context.signal.aborted) {
          clearTimeout(timeoutId);
          reject(new Error('Operation was already cancelled'));
          return;
        }
        context.signal.addEventListener('abort', abortHandler, { once: true });
      }

      definition
        .execute(args, context)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
    });
  }

  /**
   * Run post-execute hooks in priority order.
   */
  private async runPostExecuteHooks(
    definition: ToolDefinition,
    result: ToolResult,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    let currentResult = result;

    for (const { hook } of this.postExecuteHooks) {
      try {
        const hookResult = await hook(definition, currentResult as unknown as Record<string, unknown>, context);
        // Hooks can return a modified result.
        if (hookResult && 'content' in hookResult) {
          currentResult = hookResult as unknown as ToolResult;
        }
      } catch (err) {
        // Post-execute hook failures shouldn't fail the tool.
        // Log but continue.
        context.pluginContext.logger.warn(
          `Post-execute hook error for "${definition.name}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    return currentResult;
  }

  /**
   * Clear all hooks and guards.
   */
  clear(): void {
    this.preExecuteHooks = [];
    this.postExecuteHooks = [];
    this.guards = [];
  }
}

/**
 * Sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
