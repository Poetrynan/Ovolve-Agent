/**
 * HookRunner — Main hook execution engine.
 *
 * Loads hook configurations and executes external scripts at key points
 * in the agent lifecycle. Integrates with the PluginManager.
 */

import { EventEmitter } from 'events';
import type {
  HookConfig,
  HookContext,
  HookResult,
  HookExecutionResult,
  HookOutput,
  HookRunnerOptions,
  HookAuditEvent,
} from './types.js';
import { HookEvent, ALL_HOOK_EVENTS, isHookEvent } from './events.js';
import { executeHookScripts, parseHookOutput, validateHookOutput } from './script-executor.js';
import { loadDefaultConfig, findConfigFiles, loadMergedConfig } from './config-discovery.js';

/** Plugin manager interface (provided by @oa/plugins) */
export interface PluginManager {
  emit(event: string, ...args: unknown[]): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * HookRunner manages the lifecycle of hook execution.
 *
 * Responsibilities:
 * - Load hook configurations from project and user dirs
 * - Execute hooks for specific events
 * - Validate hook outputs
 * - Maintain enable/disable state
 * - Emit audit events
 */
export class HookRunner extends EventEmitter {
  private config: HookConfig;
  private options: HookRunnerOptions;
  private enabled: boolean;
  private pluginManager: PluginManager | null = null;
  private auditLog: HookAuditEvent[] = [];
  private executing: boolean = false;

  constructor(config?: HookConfig, options?: HookRunnerOptions) {
    super();
    this.config = config ?? { hooks: {} };
    this.options = options ?? {};
    this.enabled = options?.enabled ?? this.config.enabled ?? true;
  }

  /**
   * Load hook configuration from file paths.
   * Merges project and user configs.
   */
  loadConfig(paths?: string[]): void {
    const configPaths = paths ?? findConfigFiles(this.options.projectDir);
    this.config = loadMergedConfig(configPaths);
    this.emit('config_loaded', this.config);
  }

  /**
   * Load config from default locations.
   */
  loadDefaultConfig(): void {
    this.loadConfig();
  }

  /**
   * Execute all hooks for a given event.
   *
   * @param event - The hook event to trigger
   * @param context - Additional context for the hook
   * @returns Aggregated result from all executed hooks
   */
  async execute(event: HookEvent, context?: Partial<HookContext>): Promise<HookExecutionResult> {
    if (!this.enabled) {
      return {
        event,
        results: [],
        blocked: false,
        combinedOutput: {},
        duration: 0,
      };
    }

    if (this.executing) {
      throw new Error('Hook execution already in progress (reentrant call detected)');
    }

    this.executing = true;
    const startTime = Date.now();

    try {
      // Build full context
      const fullContext = this.buildContext(event, context);

      // Get scripts for this event
      const scripts = this.config.hooks[event] ?? [];

      this.emit('hooks_executing', event, scripts.length);
      this.pluginManager?.emit('hooks_executing', event, scripts.length);

      // Execute all scripts
      const results = await executeHookScripts(scripts, fullContext);

      // Aggregate results
      const blocked = results.some((r) => r.blocked);
      const blockReason = results.find((r) => r.blocked)?.output?.blockReason;
      const combinedOutput = this.combineOutputs(results);
      const duration = Date.now() - startTime;

      const executionResult: HookExecutionResult = {
        event,
        results,
        blocked,
        blockReason,
        combinedOutput,
        duration,
      };

      // Record audit events
      for (const result of results) {
        this.recordAuditEvent({
          timestamp: Date.now(),
          event,
          script: result.script.command,
          exitCode: result.exitCode,
          duration: result.duration,
          blocked: result.blocked,
          error: result.error,
        });
      }

      this.emit('hooks_executed', executionResult);
      this.pluginManager?.emit('hooks_executed', executionResult);

      return executionResult;
    } finally {
      this.executing = false;
    }
  }

  /**
   * Validate hook output JSON.
   * Returns validation errors (empty array if valid).
   */
  validateHookOutput(output: HookOutput): string[] {
    return validateHookOutput(output);
  }

  /**
   * Check if hooks are currently enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enable hook execution.
   */
  enable(): void {
    this.enabled = true;
    this.emit('enabled');
  }

  /**
   * Disable hook execution.
   */
  disable(): void {
    this.enabled = false;
    this.emit('disabled');
  }

  /**
   * Toggle hooks on/off.
   */
  toggle(): boolean {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.emit('enabled');
    } else {
      this.emit('disabled');
    }
    return this.enabled;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): HookConfig {
    return { ...this.config };
  }

  /**
   * Update the configuration.
   */
  setConfig(config: HookConfig): void {
    this.config = config;
    this.emit('config_updated', config);
  }

  /**
   * Set the plugin manager for integration.
   */
  setPluginManager(manager: PluginManager): void {
    this.pluginManager = manager;
  }

  /**
   * Get the audit log.
   */
  getAuditLog(): HookAuditEvent[] {
    return [...this.auditLog];
  }

  /**
   * Clear the audit log.
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  /**
   * Check if a specific event has any hooks configured.
   */
  hasHooksForEvent(event: HookEvent): boolean {
    const scripts = this.config.hooks[event];
    return scripts !== undefined && scripts.length > 0;
  }

  /**
   * Get all events that have hooks configured.
   */
  getActiveEvents(): HookEvent[] {
    return ALL_HOOK_EVENTS.filter((event) => this.hasHooksForEvent(event));
  }

  /**
   * Get hook scripts for a specific event.
   */
  getHooksForEvent(event: HookEvent): HookConfig['hooks'][HookEvent] {
    return this.config.hooks[event] ?? [];
  }

  /**
   * Add a hook script to an event.
   */
  addHook(event: HookEvent, script: HookScript): void {
    if (!this.config.hooks[event]) {
      this.config.hooks[event] = [];
    }
    this.config.hooks[event]!.push(script);
    this.emit('hook_added', event, script);
  }

  /**
   * Remove a hook script from an event by index.
   */
  removeHook(event: HookEvent, index: number): boolean {
    const scripts = this.config.hooks[event];
    if (!scripts || index < 0 || index >= scripts.length) {
      return false;
    }
    const removed = scripts.splice(index, 1)[0];
    this.emit('hook_removed', event, removed);
    return true;
  }

  /**
   * Build the full hook context from event and partial context.
   */
  private buildContext(event: HookEvent, partial?: Partial<HookContext>): HookContext {
    return {
      event,
      timestamp: Date.now(),
      projectDir: partial?.projectDir ?? this.options.projectDir ?? process.cwd(),
      homeDir: partial?.homeDir ?? this.options.homeDir ?? require('os').homedir(),
      sessionId: partial?.sessionId,
      data: partial?.data,
      ...partial,
    };
  }

  /**
   * Combine outputs from multiple hook results.
   * Later hooks override earlier ones for conflicting keys.
   */
  private combineOutputs(results: HookResult[]): HookOutput {
    const combined: HookOutput = {};

    for (const result of results) {
      if (!result.output) continue;

      for (const [key, value] of Object.entries(result.output)) {
        if (value !== undefined) {
          (combined as Record<string, unknown>)[key] = value;
        }
      }
    }

    return combined;
  }

  /**
   * Record an audit event, keeping the last 1000 entries.
   */
  private recordAuditEvent(event: HookAuditEvent): void {
    this.auditLog.push(event);
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
  }
}

/**
 * Factory function to create a HookRunner instance.
 */
export function createHookRunner(
  config?: HookConfig,
  options?: HookRunnerOptions,
): HookRunner {
  const runner = new HookRunner(config, options);

  // Auto-load config from default locations if no config provided
  if (!config) {
    runner.loadDefaultConfig();
  }

  return runner;
}
