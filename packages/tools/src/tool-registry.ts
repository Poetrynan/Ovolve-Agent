/**
 * @oa/tools — ToolRegistry
 *
 * Central registry for all tools in the OvolveAgent system.
 * Manages tool registration, lookup, filtering, and dispatch.
 * Integrates with the plugin system for hook execution.
 */

import {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  ToolCall,
  ToolCallStatus,
  ToolRegistryConfig,
  ToolListFilter,
  HistoryEntry,
  DispatchOptions,
  DispatchResult,
  ToolScope,
  ToolServices,
} from './types';
import { ToolExecutionMode } from './types';
import { createErrorResult, generateCallId, validateToolDefinition } from './tool-definition';
import { ExecutionPipeline, PipelineError } from './execution-pipeline';
import { HookPoint, PluginManager } from '@oa/plugins';

/**
 * Default no-op logger for when no plugin context is available.
 */
const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: ToolRegistryConfig = {
  maxConcurrency: 10,
  defaultTimeoutMs: 30000,
  recordHistory: true,
  maxHistoryEntries: 1000,
};

/**
 * The ToolRegistry manages all tool definitions and their execution.
 * It provides scoped registration, concurrency control, and history tracking.
 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private pipeline: ExecutionPipeline;
  private config: ToolRegistryConfig;
  private history: HistoryEntry[] = [];
  private activeExecutions: Map<string, { promise: Promise<DispatchResult>; startTime: number }> = new Map();
  private pluginManager?: PluginManager;

  constructor(config: Partial<ToolRegistryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.pipeline = new ExecutionPipeline();
    this.pluginManager = config.pluginManager;
  }

  // ─── Registration ─────────────────────────────────────────────────────

  /**
   * Register a tool definition.
   * Validates the tool before adding it to the registry.
   *
   * @param definition The tool definition to register.
   * @throws Error if validation fails or tool already exists.
   */
  register(definition: ToolDefinition): void {
    // Validate the tool definition.
    const validation = validateToolDefinition(definition);
    if (!validation.valid) {
      throw new Error(
        `Invalid tool definition "${definition.name}": ${validation.errors.join(', ')}`
      );
    }

    // Check for duplicate.
    if (this.tools.has(definition.name)) {
      throw new Error(
        `Tool "${definition.name}" is already registered. Unregister it first.`
      );
    }

    this.tools.set(definition.name, definition);
  }

  /**
   * Register multiple tools at once.
   */
  registerAll(definitions: ToolDefinition[]): void {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  /**
   * Unregister a tool by name.
   *
   * @param name The name of the tool to unregister.
   * @returns True if the tool was removed, false if not found.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get a tool definition by name.
   */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * List all registered tools, optionally filtered.
   */
  listTools(filter?: ToolListFilter): ToolDefinition[] {
    let tools = Array.from(this.tools.values());

    if (filter) {
      if (filter.scope !== undefined) {
        tools = tools.filter((t) => t.scope === filter.scope);
      }
      if (filter.agentId !== undefined) {
        tools = tools.filter((t) => t.agentId === filter.agentId);
      }
      if (filter.sessionId !== undefined) {
        tools = tools.filter((t) => t.sessionId === filter.sessionId);
      }
      if (filter.riskLevel !== undefined) {
        tools = tools.filter((t) => t.riskLevel === filter.riskLevel);
      }
      if (filter.executionMode !== undefined) {
        tools = tools.filter((t) => t.executionMode === filter.executionMode);
      }
      if (filter.namePattern !== undefined) {
        tools = tools.filter((t) => filter.namePattern!.test(t.name));
      }
    }

    return tools;
  }

  /**
   * Get tool names only (useful for LLM context).
   */
  getToolNames(filter?: ToolListFilter): string[] {
    return this.listTools(filter).map((t) => t.name);
  }

  /**
   * Get the number of registered tools.
   */
  get toolCount(): number {
    return this.tools.size;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────────

  /**
   * Dispatch a tool execution by name.
   * This is the main entry point for running tools.
   *
   * @param name The tool name.
   * @param args The arguments to pass.
   * @param context The execution context.
   * @param options Optional dispatch options.
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
    context: Partial<ToolExecutionContext> = {},
    options: DispatchOptions = {}
  ): Promise<DispatchResult> {
    const definition = this.tools.get(name);

    if (!definition) {
      const call: ToolCall = {
        id: generateCallId(),
        name,
        args,
        timestamp: new Date(),
        status: ToolCallStatus.FAILED,
      };
      return {
        call,
        result: createErrorResult(
          'TOOL_NOT_FOUND',
          `Tool "${name}" is not registered`,
          false,
          { availableTools: this.getToolNames() }
        ),
      };
    }

    // Build the full execution context.
    const fullContext = this.buildContext(context);

    // Check concurrency limits.
    if (!this.canExecute(definition)) {
      const call: ToolCall = {
        id: generateCallId(),
        name,
        args,
        timestamp: new Date(),
        status: ToolCallStatus.BLOCKED,
      };
      return {
        call,
        result: createErrorResult(
          'CONCURRENCY_LIMIT',
          `Tool "${name}" cannot execute: concurrency limit reached or exclusive lock active`,
          true,
          { maxConcurrency: this.config.maxConcurrency }
        ),
      };
    }

    // Run plugin hooks if plugin manager is available.
    if (this.pluginManager && !options.skipHooks) {
      const hookResult = await this.pluginManager.emit(
        HookPoint.PRE_TOOL_USE,
        { toolName: name, args, scope: definition.scope },
        { sessionId: fullContext.pluginContext.sessionId, agentId: fullContext.pluginContext.agentId }
      );

      if (hookResult.blocked) {
        const call: ToolCall = {
          id: generateCallId(),
          name,
          args,
          timestamp: new Date(),
          status: ToolCallStatus.BLOCKED,
        };
        return {
          call,
          result: createErrorResult(
            'HOOK_BLOCKED',
            hookResult.blockReason ?? 'Execution blocked by plugin hook',
            false,
            { blockedBy: hookResult.blockedBy }
          ),
        };
      }

      // Update args if hook modified them.
      if (hookResult.payload && typeof hookResult.payload === 'object') {
        args = (hookResult.payload as { args?: Record<string, unknown> }).args ?? args;
      }
    }

    // Track execution.
    const callId = generateCallId();
    const executionPromise = this.executeTool(definition, args, fullContext, options, callId);
    this.activeExecutions.set(callId, { promise: executionPromise, startTime: Date.now() });

    try {
      const result = await executionPromise;
      return result;
    } finally {
      this.activeExecutions.delete(callId);
    }
  }

  /**
   * Dispatch multiple tools in parallel.
   */
  async dispatchParallel(
    calls: Array<{ name: string; args: Record<string, unknown> }>,
    context: Partial<ToolExecutionContext> = {},
    options: DispatchOptions = {}
  ): Promise<DispatchResult[]> {
    const promises = calls.map((c) => this.dispatch(c.name, c.args, context, options));
    return Promise.all(promises);
  }

  /**
   * Dispatch multiple tools sequentially.
   */
  async dispatchSequential(
    calls: Array<{ name: string; args: Record<string, unknown> }>,
    context: Partial<ToolExecutionContext> = {},
    options: DispatchOptions = {}
  ): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const call of calls) {
      const result = await this.dispatch(call.name, call.args, context, options);
      results.push(result);
    }
    return results;
  }

  // ─── Execution ────────────────────────────────────────────────────────

  /**
   * Execute a tool through the pipeline.
   */
  private async executeTool(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    options: DispatchOptions,
    callId: string
  ): Promise<DispatchResult> {
    const startTime = Date.now();

    const call: ToolCall = {
      id: callId,
      name: definition.name,
      args,
      timestamp: new Date(),
      status: ToolCallStatus.EXECUTING,
      context: {
        depth: context.depth,
        parentCallId: context.parentCallId,
      },
    };

    // Run through the execution pipeline.
    const pipelineResult = await this.pipeline.execute(definition, args, context, options);

    // Run post-execution plugin hooks.
    if (this.pluginManager && !options.skipHooks) {
      await this.pluginManager.emit(
        HookPoint.POST_TOOL_USE,
        {
          toolName: definition.name,
          args,
          result: pipelineResult.result,
        },
        {
          sessionId: context.pluginContext.sessionId,
          agentId: context.pluginContext.agentId,
        }
      );
    }

    // Record history.
    if (this.config.recordHistory) {
      this.addToHistory({
        call: pipelineResult.call,
        result: pipelineResult.result,
        completedAt: new Date(),
      });
    }

    return pipelineResult;
  }

  /**
   * Check if a tool can execute given concurrency constraints.
   */
  private canExecute(definition: ToolDefinition): boolean {
    // Exclusive tools require no other active executions.
    if (definition.executionMode === ToolExecutionMode.EXCLUSIVE) {
      // Check if there's any exclusive tool running.
      for (const [name] of this.tools) {
        const tool = this.tools.get(name);
        if (tool?.executionMode === ToolExecutionMode.EXCLUSIVE && this.isToolActive(name)) {
          return false;
        }
      }
    }

    // Check overall concurrency limit.
    if (this.activeExecutions.size >= this.config.maxConcurrency) {
      return false;
    }

    return true;
  }

  /**
   * Check if a specific tool is currently executing.
   */
  private isToolActive(name: string): boolean {
    for (const [, entry] of this.activeExecutions) {
      // This is a simplification — in production you'd track by name.
      if (Date.now() - entry.startTime < this.config.defaultTimeoutMs * 2) {
        return true;
      }
    }
    return false;
  }

  // ─── Context Building ─────────────────────────────────────────────────

  /**
   * Build a full execution context from partial input.
   */
  private buildContext(partial: Partial<ToolExecutionContext>): ToolExecutionContext {
    const services: ToolServices = {
      askUser: partial.services?.askUser ?? (async (q) => ''),
      spawnSubAgent: partial.services?.spawnSubAgent ?? (async () => ''),
      getEventStore: partial.services?.getEventStore,
    };

    return {
      pluginContext: partial.pluginContext ?? {
        sessionId: 'default',
        agentId: 'default',
        metadata: {},
        logger: noopLogger,
      },
      signal: partial.signal,
      depth: partial.depth ?? 0,
      parentCallId: partial.parentCallId,
      services,
    };
  }

  // ─── History ──────────────────────────────────────────────────────────

  /**
   * Add an entry to the history, maintaining the max size.
   */
  private addToHistory(entry: HistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > this.config.maxHistoryEntries) {
      this.history = this.history.slice(-this.config.maxHistoryEntries);
    }
  }

  /**
   * Get the tool call history.
   */
  getHistory(): HistoryEntry[] {
    return [...this.history];
  }

  /**
   * Get history for a specific tool.
   */
  getHistoryForTool(toolName: string): HistoryEntry[] {
    return this.history.filter((h) => h.call.name === toolName);
  }

  /**
   * Clear the history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Get the number of active executions.
   */
  get activeExecutionCount(): number {
    return this.activeExecutions.size;
  }

  // ─── Pipeline Access ──────────────────────────────────────────────────

  /**
   * Get the execution pipeline for adding hooks and guards.
   */
  getPipeline(): ExecutionPipeline {
    return this.pipeline;
  }

  // ─── Plugin Manager ───────────────────────────────────────────────────

  /**
   * Set the plugin manager for hook integration.
   */
  setPluginManager(manager: PluginManager): void {
    this.pluginManager = manager;
  }

  /**
   * Get the plugin manager.
   */
  getPluginManager(): PluginManager | undefined {
    return this.pluginManager;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Clear all registered tools and history.
   */
  clear(): void {
    this.tools.clear();
    this.history = [];
    this.activeExecutions.clear();
    this.pipeline.clear();
  }
}

/**
 * Factory function to create a ToolRegistry.
 */
export function createToolRegistry(config: Partial<ToolRegistryConfig> = {}): ToolRegistry {
  return new ToolRegistry(config);
}
