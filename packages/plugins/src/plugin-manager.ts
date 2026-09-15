/**
 * @oa/plugins — PluginManager
 *
 * Central orchestrator for the plugin system. Handles loading, unloading,
 * dependency resolution, event emission, and hook dispatch.
 *
 * Plugin microkernel and hook dispatch for OvolveAgent.
 */

import {
  IPlugin,
  PluginContext,
  PluginManifest,
  HookPoint,
  HookHandler,
  HookSubscription,
  HookRegistry,
  LoadedPlugin,
  PluginStatus,
  PluginManagerConfig,
  PluginEvent,
  LoadResult,
  DependencyResolution,
  Logger,
  WaterfallOptions,
} from './types';
import {
  HookRunner,
  HookResult,
  generateSubscriptionId,
} from './hook-runner';

/**
 * Default no-op logger.
 */
const defaultLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The PluginManager is the core of the plugin system.
 * It manages plugin lifecycle, dependency resolution, and event dispatch.
 */
export class PluginManager {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private hookRunner: HookRunner;
  private logger: Logger;
  // logger/resolveDependencies/allowDuplicateNames always get defaults;
  // defaultSignal/onEvent legitimately stay optional after resolution.
  private config: Omit<Required<PluginManagerConfig>, 'defaultSignal' | 'onEvent'> &
    Pick<PluginManagerConfig, 'defaultSignal' | 'onEvent'>;
  private eventListeners: Map<string, Array<(event: PluginEvent) => void>> = new Map();
  private loadOrder: string[] = [];

  constructor(config: PluginManagerConfig = {}) {
    this.config = {
      logger: config.logger ?? defaultLogger,
      resolveDependencies: config.resolveDependencies ?? true,
      allowDuplicateNames: config.allowDuplicateNames ?? false,
      defaultSignal: config.defaultSignal,
      onEvent: config.onEvent,
    };
    this.logger = this.config.logger;
    this.hookRunner = new HookRunner(this.logger);
  }

  // ─── Plugin Lifecycle ───────────────────────────────────────────────

  /**
   * Load a plugin: resolve dependencies, register hooks, and call onLoad.
   *
   * @param plugin The plugin to load.
   * @param context Optional context override for this load operation.
   * @returns The result of the load operation.
   */
  async load(plugin: IPlugin, context?: Partial<PluginContext>): Promise<LoadResult> {
    const startTime = Date.now();
    const { name } = plugin.manifest;

    this.logger.info(`PluginManager: loading plugin "${name}" v${plugin.manifest.version}`);

    // Check for duplicate names.
    if (this.plugins.has(name) && !this.config.allowDuplicateNames) {
      const error = `Plugin "${name}" is already loaded. Unload it first or enable allowDuplicateNames.`;
      this.logger.error(`PluginManager: ${error}`);
      return {
        pluginName: name,
        success: false,
        error,
        durationMs: Date.now() - startTime,
      };
    }

    // Create the loaded plugin record.
    const loadedPlugin: LoadedPlugin = {
      plugin,
      subscriptions: [],
      loadedAt: new Date(),
      status: PluginStatus.LOADING,
    };

    try {
      // Resolve dependencies if enabled.
      if (this.config.resolveDependencies && plugin.manifest.dependencies?.length) {
        const resolution = this.resolveDependencies(plugin.manifest);
        if (resolution.missing.length > 0) {
          const error = `Missing dependencies for "${name}": ${resolution.missing.join(', ')}`;
          this.logger.error(`PluginManager: ${error}`);
          return {
            pluginName: name,
            success: false,
            error,
            durationMs: Date.now() - startTime,
          };
        }
        if (resolution.circular.length > 0) {
          const error = `Circular dependencies detected: ${resolution.circular
            .map((c) => c.join(' -> '))
            .join('; ')}`;
          this.logger.error(`PluginManager: ${error}`);
          return {
            pluginName: name,
            success: false,
            error,
            durationMs: Date.now() - startTime,
          };
        }
      }

      // Register the plugin before calling register() so it can be found.
      this.plugins.set(name, loadedPlugin);

      // Build the hook registry for this plugin.
      const registry = this.createHookRegistry(name, loadedPlugin);

      // Build the context.
      const pluginContext = this.buildContext(context);

      // Call the plugin's register method to subscribe hooks.
      await plugin.register(registry, pluginContext);

      // Call onLoad lifecycle hook.
      if (plugin.onLoad) {
        await plugin.onLoad(pluginContext);
      }

      loadedPlugin.status = PluginStatus.ACTIVE;
      this.loadOrder.push(name);

      // Emit plugin loaded event.
      this.emitEvent('plugin:loaded', name, {
        version: plugin.manifest.version,
        hookPoints: plugin.manifest.hookPoints,
      });

      const durationMs = Date.now() - startTime;
      this.logger.info(`PluginManager: plugin "${name}" loaded successfully in ${durationMs}ms`);

      return {
        pluginName: name,
        success: true,
        durationMs,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      loadedPlugin.status = PluginStatus.ERROR;
      this.plugins.delete(name);
      this.logger.error(`PluginManager: failed to load "${name}": ${errorMessage}`);

      return {
        pluginName: name,
        success: false,
        error: errorMessage,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Unload a plugin: call onUnload, remove subscriptions, and cleanup.
   *
   * @param name The name of the plugin to unload.
   * @returns True if the plugin was unloaded, false if not found.
   */
  async unload(name: string, context?: Partial<PluginContext>): Promise<boolean> {
    this.logger.info(`PluginManager: unloading plugin "${name}"`);

    const loadedPlugin = this.plugins.get(name);
    if (!loadedPlugin) {
      this.logger.warn(`PluginManager: plugin "${name}" not found for unloading`);
      return false;
    }

    loadedPlugin.status = PluginStatus.UNLOADING;

    try {
      // Call onUnload lifecycle hook.
      if (loadedPlugin.plugin.onUnload) {
        const pluginContext = this.buildContext(context);
        await loadedPlugin.plugin.onUnload(pluginContext);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `PluginManager: error during onUnload for "${name}": ${errorMessage}`
      );
      // Continue cleanup even if onUnload fails.
    }

    // Remove all hook subscriptions for this plugin.
    const removedCount = this.hookRunner.removeSubscriptionsByPlugin(name);
    this.logger.debug(
      `PluginManager: removed ${removedCount} subscription(s) for "${name}"`
    );

    // Remove from tracking.
    this.plugins.delete(name);
    this.loadOrder = this.loadOrder.filter((n) => n !== name);

    // Emit plugin unloaded event.
    this.emitEvent('plugin:unloaded', name, {});

    this.logger.info(`PluginManager: plugin "${name}" unloaded`);
    return true;
  }

  /**
   * Unload all plugins in reverse load order.
   */
  async unloadAll(context?: Partial<PluginContext>): Promise<void> {
    // Unload in reverse dependency order.
    const reversed = [...this.loadOrder].reverse();
    for (const name of reversed) {
      await this.unload(name, context);
    }
  }

  /**
   * Get a loaded plugin by name.
   */
  getPlugin(name: string): IPlugin | undefined {
    return this.plugins.get(name)?.plugin;
  }

  /**
   * Get the full loaded plugin record including status.
   */
  getLoadedPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * List all loaded plugins.
   */
  listPlugins(): IPlugin[] {
    return Array.from(this.plugins.values()).map((lp) => lp.plugin);
  }

  /**
   * List all loaded plugin manifests.
   */
  listManifests(): PluginManifest[] {
    return Array.from(this.plugins.values()).map((lp) => lp.plugin.manifest);
  }

  /**
   * Check if a plugin is loaded and active.
   */
  isActive(name: string): boolean {
    return this.plugins.get(name)?.status === PluginStatus.ACTIVE;
  }

  // ─── Hook Execution ─────────────────────────────────────────────────

  /**
   * Execute all handlers for a hook point.
   * Short-circuits on the first block signal.
   */
  async emit<T = unknown>(
    hookPoint: HookPoint,
    payload: T,
    context?: Partial<PluginContext>
  ): Promise<HookResult<T>> {
    const pluginContext = this.buildContext(context);
    return this.hookRunner.execute(hookPoint, payload, pluginContext);
  }

  /**
   * Execute a waterfall middleware chain for a hook point.
   */
  async waterfall<T = unknown>(
    hookPoint: HookPoint,
    payload: T,
    context?: Partial<PluginContext>,
    options?: WaterfallOptions
  ): Promise<HookResult<T>> {
    const pluginContext = this.buildContext(context);
    return this.hookRunner.waterfall(hookPoint, payload, pluginContext, options);
  }

  /**
   * Subscribe to a hook point directly (not through a plugin).
   * Useful for ad-hoc integrations.
   */
  on(
    hookPoint: HookPoint,
    handler: HookHandler,
    priority = 100,
    pluginName = '__direct__'
  ): string {
    const id = generateSubscriptionId();
    const subscription: HookSubscription = {
      id,
      hookPoint,
      handler,
      priority,
      pluginName,
      async: this.isAsyncFunction(handler),
    };
    this.hookRunner.addSubscription(subscription);
    return id;
  }

  /**
   * Remove a direct subscription by id.
   */
  off(subscriptionId: string): boolean {
    return this.hookRunner.removeSubscription(subscriptionId);
  }

  // ─── Event System ────────────────────────────────────────────────────

  /**
   * Emit a named event to all subscribers.
   * This is separate from hook execution — events are for observation,
   * not for modifying behavior.
   */
  emitEvent(type: string, source: string, payload?: unknown): void {
    const event: PluginEvent = {
      type,
      source,
      timestamp: new Date(),
      payload,
    };

    // Notify direct listeners.
    const listeners = this.eventListeners.get(type) || [];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error(
          `PluginManager: event listener error for "${type}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    // Notify the global event store integration.
    if (this.config.onEvent) {
      try {
        this.config.onEvent(event);
      } catch (err) {
        this.logger.error(
          `PluginManager: onEvent callback error: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  /**
   * Subscribe to plugin system events.
   * @param type Event type to listen for, or '*' for all events.
   * @param handler The handler function.
   * @returns An unsubscribe function.
   */
  onEvent(type: string, handler: (event: PluginEvent) => void): () => void {
    const listeners = this.eventListeners.get(type) || [];
    listeners.push(handler);
    this.eventListeners.set(type, listeners);

    // Return unsubscribe function.
    return () => {
      const current = this.eventListeners.get(type) || [];
      const filtered = current.filter((h) => h !== handler);
      this.eventListeners.set(type, filtered);
    };
  }

  // ─── Dependency Resolution ───────────────────────────────────────────

  /**
   * Resolve plugin dependencies via topological sort.
   * Returns the correct load order, missing dependencies, and circular refs.
   */
  resolveDependencies(manifest: PluginManifest): DependencyResolution {
    const graph = this.buildDependencyGraph();
    const missing: string[] = [];
    const circular: string[][] = [];

    // Check for missing dependencies.
    const checkMissing = (name: string, deps: string[], visited: Set<string>) => {
      for (const dep of deps) {
        if (!graph.has(dep) && !this.plugins.has(dep)) {
          missing.push(dep);
        }
        if (visited.has(dep)) {
          circular.push([name, dep]);
        }
      }
    };

    // Topological sort using Kahn's algorithm.
    const sorted: string[] = [];
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    // Build adjacency list from all loaded plugins + the new manifest.
    const allManifests = new Map<string, PluginManifest>();
    for (const [name, lp] of this.plugins) {
      allManifests.set(name, lp.plugin.manifest);
    }
    allManifests.set(manifest.name, manifest);

    for (const [name, m] of allManifests) {
      if (!inDegree.has(name)) {
        inDegree.set(name, 0);
      }
      const deps = m.dependencies || [];
      checkMissing(name, deps, new Set());
      for (const dep of deps) {
        const edges = adjList.get(dep) || [];
        edges.push(name);
        adjList.set(dep, edges);
        inDegree.set(name, (inDegree.get(name) || 0) + 1);
      }
    }

    // Find all nodes with no incoming edges.
    const queue: string[] = [];
    for (const [name, degree] of inDegree) {
      if (degree === 0) {
        queue.push(name);
      }
    }

    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);
      const neighbors = adjList.get(node) || [];
      for (const neighbor of neighbors) {
        const newDegree = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    return { order: sorted, missing, circular };
  }

  /**
   * Build a dependency graph from all loaded plugins.
   */
  private buildDependencyGraph(): Map<string, PluginManifest> {
    const graph = new Map<string, PluginManifest>();
    for (const [name, lp] of this.plugins) {
      graph.set(name, lp.plugin.manifest);
    }
    return graph;
  }

  // ─── Health Checks ───────────────────────────────────────────────────

  /**
   * Run health checks on all loaded plugins that implement onHealthCheck.
   */
  async healthCheck(): Promise<Map<string, { healthy: boolean; message?: string }>> {
    const results = new Map<string, { healthy: boolean; message?: string }>();

    for (const [name, lp] of this.plugins) {
      if (lp.plugin.onHealthCheck) {
        try {
          const status = await lp.plugin.onHealthCheck();
          results.set(name, {
            healthy: status.healthy,
            message: status.message,
          });
        } catch (err) {
          results.set(name, {
            healthy: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        results.set(name, { healthy: true, message: 'No health check implemented' });
      }
    }

    return results;
  }

  // ─── Internal Helpers ────────────────────────────────────────────────

  /**
   * Create a HookRegistry bound to a specific plugin.
   */
  private createHookRegistry(
    pluginName: string,
    loadedPlugin: LoadedPlugin
  ): HookRegistry {
    const runner = this.hookRunner;

    return {
      on<T>(hookPoint: HookPoint, handler: HookHandler<T>, priority = 100) {
        const id = generateSubscriptionId();
        const subscription: HookSubscription = {
          id,
          hookPoint,
          // Handlers are stored type-erased; payload shapes are enforced by
          // each HookPoint's runtime contract, not by the registry.
          handler: handler as HookHandler,
          priority,
          pluginName,
          async: false, // Will be determined at execution time.
        };
        runner.addSubscription(subscription);
        loadedPlugin.subscriptions.push(subscription);
      },
    };
  }

  /**
   * Build a PluginContext from partial overrides.
   */
  private buildContext(partial?: Partial<PluginContext>): PluginContext {
    return {
      sessionId: partial?.sessionId ?? 'default',
      agentId: partial?.agentId ?? 'default',
      userId: partial?.userId,
      metadata: partial?.metadata ?? {},
      signal: partial?.signal ?? this.config.defaultSignal,
      logger: partial?.logger ?? this.logger,
    };
  }

  /**
   * Check if a function is async.
   */
  private isAsyncFunction(fn: Function): boolean {
    return fn.constructor.name === 'AsyncFunction';
  }

  /**
   * Get the current load order.
   */
  getLoadOrder(): string[] {
    return [...this.loadOrder];
  }

  /**
   * Get the number of loaded plugins.
   */
  get pluginCount(): number {
    return this.plugins.size;
  }
}

/**
 * Factory function to create a PluginManager with the given configuration.
 */
export function createPluginManager(config: PluginManagerConfig = {}): PluginManager {
  return new PluginManager(config);
}
