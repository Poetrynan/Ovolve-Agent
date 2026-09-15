/**
 * @oa/plugins — Hook Execution Engine
 *
 * Priority-ordered handler execution with short-circuit support,
 * async handling, and timeout enforcement.
 */

import {
  HookPoint,
  HookSubscription,
  HookHandler,
  HookControl,
  PluginContext,
  Logger,
  WaterfallOptions,
} from './types';

/**
 * Result of executing a hook point across all subscribed handlers.
 */
export interface HookResult<T = unknown> {
  /** The final payload after all handlers processed it. */
  payload: T;
  /** Whether any handler blocked the operation. */
  blocked: boolean;
  /** The reason for blocking, if any. */
  blockReason?: string;
  /** The name of the plugin that blocked, if any. */
  blockedBy?: string;
  /** Number of handlers that executed. */
  handlerCount: number;
  /** Errors caught during execution (non-blocking). */
  errors: HookError[];
  /** Total execution time in milliseconds. */
  durationMs: number;
}

/**
 * Captured error from a hook handler that chose not to throw.
 */
export interface HookError {
  pluginName: string;
  handlerId: string;
  error: string;
}

/**
 * The HookRunner manages handler execution for a single hook point.
 * Handlers are sorted by priority (ascending) and executed in order.
 */
export class HookRunner {
  private subscriptions: Map<HookPoint, HookSubscription[]> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    // Initialize all hook points with empty arrays.
    for (const hookPoint of Object.values(HookPoint)) {
      this.subscriptions.set(hookPoint, []);
    }
  }

  /**
   * Add a subscription to a hook point. Maintains priority order.
   */
  addSubscription(subscription: HookSubscription): void {
    const handlers = this.subscriptions.get(subscription.hookPoint);
    if (!handlers) {
      throw new Error(`Unknown hook point: ${subscription.hookPoint}`);
    }

    handlers.push(subscription);
    // Sort by priority ascending (lower = earlier).
    handlers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Remove all subscriptions for a given plugin.
   */
  removeSubscriptionsByPlugin(pluginName: string): number {
    let removed = 0;
    for (const [hookPoint, handlers] of this.subscriptions) {
      const filtered = handlers.filter((h) => h.pluginName !== pluginName);
      removed += handlers.length - filtered.length;
      this.subscriptions.set(hookPoint, filtered);
    }
    return removed;
  }

  /**
   * Remove a specific subscription by id.
   */
  removeSubscription(subscriptionId: string): boolean {
    for (const [hookPoint, handlers] of this.subscriptions) {
      const index = handlers.findIndex((h) => h.id === subscriptionId);
      if (index !== -1) {
        handlers.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Get all subscriptions for a hook point (sorted by priority).
   */
  getSubscriptions(hookPoint: HookPoint): HookSubscription[] {
    return [...(this.subscriptions.get(hookPoint) || [])];
  }

  /**
   * Get the count of subscribers for a hook point.
   */
  subscriberCount(hookPoint: HookPoint): number {
    return this.subscriptions.get(hookPoint)?.length || 0;
  }

  /**
   * Execute all handlers for a hook point in priority order.
   * Short-circuits on the first block signal.
   *
   * @param hookPoint The hook point to execute.
   * @param initialPayload The initial payload passed to the first handler.
   * @param context The plugin context.
   * @returns The result of the hook execution.
   */
  async execute<T = unknown>(
    hookPoint: HookPoint,
    initialPayload: T,
    context: PluginContext
  ): Promise<HookResult<T>> {
    const startTime = Date.now();
    const handlers = this.subscriptions.get(hookPoint) || [];
    const errors: HookError[] = [];
    let payload = initialPayload;
    let blocked = false;
    let blockReason: string | undefined;
    let blockedBy: string | undefined;
    let handlerCount = 0;

    if (handlers.length === 0) {
      return {
        payload,
        blocked: false,
        handlerCount: 0,
        errors: [],
        durationMs: Date.now() - startTime,
      };
    }

    this.logger.debug(
      `HookRunner: executing ${hookPoint} with ${handlers.length} handler(s)`
    );

    for (const subscription of handlers) {
      // Check for abort before each handler.
      if (context.signal?.aborted) {
        this.logger.warn(
          `HookRunner: abort signal detected, skipping remaining handlers for ${hookPoint}`
        );
        break;
      }

      handlerCount++;
      try {
        const result = await subscription.handler(payload, context);

        if (this.isHookControl(result)) {
          // Handler returned a control object.
          if (result.blocked) {
            blocked = true;
            blockReason = result.reason;
            blockedBy = subscription.pluginName;
            if (result.payload !== undefined) {
              payload = result.payload as T;
            }
            this.logger.info(
              `HookRunner: ${hookPoint} blocked by ${subscription.pluginName}: ${result.reason}`
            );
            break;
          }
          // Not blocked — use replacement payload if provided.
          if (result.payload !== undefined) {
            payload = result.payload as T;
          }
        } else {
          // Handler returned a transformed payload.
          payload = result as T;
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        errors.push({
          pluginName: subscription.pluginName,
          handlerId: subscription.id,
          error: errorMessage,
        });
        this.logger.error(
          `HookRunner: handler error in ${subscription.pluginName} for ${hookPoint}: ${errorMessage}`
        );
        // Re-throw critical errors — let the plugin manager decide.
        if (err instanceof HookCriticalError) {
          throw err;
        }
      }
    }

    return {
      payload,
      blocked,
      blockReason,
      blockedBy,
      handlerCount,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Execute a waterfall middleware chain.
   * Each handler receives the output of the previous one.
   * Unlike `execute`, waterfall does not short-circuit on block by default
   * (use options.shortCircuit to enable).
   *
   * @param hookPoint The hook point to execute.
   * @param initialPayload The initial payload.
   * @param context The plugin context.
   * @param options Waterfall-specific options.
   */
  async waterfall<T = unknown>(
    hookPoint: HookPoint,
    initialPayload: T,
    context: PluginContext,
    options: WaterfallOptions = {}
  ): Promise<HookResult<T>> {
    const startTime = Date.now();
    const handlers = this.subscriptions.get(hookPoint) || [];
    const errors: HookError[] = [];
    let payload = initialPayload;
    let blocked = false;
    let blockReason: string | undefined;
    let blockedBy: string | undefined;
    let handlerCount = 0;

    if (handlers.length === 0) {
      return {
        payload,
        blocked: false,
        handlerCount: 0,
        errors: [],
        durationMs: Date.now() - startTime,
      };
    }

    // If a timeout is specified, wrap the execution.
    if (options.timeoutMs) {
      return this.executeWithTimeout(
        hookPoint,
        initialPayload,
        context,
        options,
        startTime
      );
    }

    for (const subscription of handlers) {
      if (context.signal?.aborted) {
        break;
      }

      handlerCount++;
      try {
        const result = await subscription.handler(payload, context);

        if (this.isHookControl(result)) {
          if (result.blocked) {
            blocked = true;
            blockReason = result.reason;
            blockedBy = subscription.pluginName;
            if (result.payload !== undefined) {
              payload = result.payload as T;
            }
            if (options.shortCircuit !== false) {
              break;
            }
          } else if (result.payload !== undefined) {
            payload = result.payload as T;
          }
        } else {
          payload = result as T;
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        errors.push({
          pluginName: subscription.pluginName,
          handlerId: subscription.id,
          error: errorMessage,
        });
        this.logger.error(
          `HookRunner.waterfall: handler error in ${subscription.pluginName}: ${errorMessage}`
        );
        if (err instanceof HookCriticalError) {
          throw err;
        }
      }
    }

    return {
      payload,
      blocked,
      blockReason,
      blockedBy,
      handlerCount,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Execute waterfall with an overall timeout.
   */
  private async executeWithTimeout<T>(
    hookPoint: HookPoint,
    initialPayload: T,
    context: PluginContext,
    options: WaterfallOptions,
    startTime: number
  ): Promise<HookResult<T>> {
    return new Promise<HookResult<T>>((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve({
          payload: initialPayload,
          blocked: true,
          blockReason: `Waterfall timed out after ${options.timeoutMs}ms`,
          blockedBy: 'HookRunner',
          handlerCount: 0,
          errors: [],
          durationMs: Date.now() - startTime,
        });
      }, options.timeoutMs);

      this.waterfall<T>(hookPoint, initialPayload, context, {
        ...options,
        timeoutMs: undefined,
      })
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          throw err;
        });
    });
  }

  /**
   * Type guard for HookControl objects.
   */
  private isHookControl(value: unknown): value is HookControl {
    return (
      typeof value === 'object' &&
      value !== null &&
      'blocked' in value &&
      typeof (value as HookControl).blocked === 'boolean'
    );
  }

  /**
   * Clear all subscriptions (used during shutdown).
   */
  clear(): void {
    for (const hookPoint of this.subscriptions.keys()) {
      this.subscriptions.set(hookPoint, []);
    }
  }
}

/**
 * Error that, when thrown inside a hook handler, will propagate
 * immediately rather than being caught and logged.
 */
export class HookCriticalError extends Error {
  constructor(
    message: string,
    public readonly pluginName: string,
    public readonly hookPoint: HookPoint
  ) {
    super(message);
    this.name = 'HookCriticalError';
  }
}

/**
 * Generate a unique subscription ID.
 */
export function generateSubscriptionId(): string {
  return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}
