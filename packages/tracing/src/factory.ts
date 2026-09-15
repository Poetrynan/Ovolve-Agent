/**
 * @oa/tracing — Tracer Factory
 *
 * Factory functions for creating fully-configured tracer instances.
 * This is the primary entry point for integrating tracing into OvolveAgent.
 *
 * Integration:
 *   - AgentLoop imports createTracer from @oa/tracing
 *   - AgentTracer emits events that EventStore records
 *   - Export createTracer(config) factory
 */

import { AgentTracer } from './agent-tracer';
import { TracingMiddleware } from './middleware';
import { createConfig, type TracingConfigFile } from './config';
import type { TracingConfig, MiddlewareOptions } from './types';

// ---------------------------------------------------------------------------
// Tracer instance (singleton support)
// ---------------------------------------------------------------------------

let globalTracer: AgentTracer | null = null;

// ---------------------------------------------------------------------------
// createTracer — Primary factory
// ---------------------------------------------------------------------------

export interface TracerFactoryOptions {
  /** Full tracing config (overrides env vars). */
  config?: Partial<TracingConfig>;
  /** Config file object (merged with env vars). */
  configFile?: TracingConfigFile;
  /** Whether to auto-initialize the tracer. */
  autoInitialize?: boolean;
  /** Whether to use the global singleton. */
  singleton?: boolean;
}

export interface TracerFactoryResult {
  /** The AgentTracer instance. */
  tracer: AgentTracer;
  /** The resolved config. */
  config: TracingConfig;
  /** Create middleware for this tracer. */
  createMiddleware: (options?: Partial<MiddlewareOptions>) => TracingMiddleware;
  /** Shutdown the tracer. */
  shutdown: () => Promise<void>;
}

/**
 * Create a fully-configured tracer instance.
 *
 * @param options — Factory options.
 * @returns The tracer, config, and helper functions.
 *
 * @example
 * ```ts
 * // From environment variables
 * const { tracer, shutdown } = await createTracer();
 *
 * // With explicit config
 * const { tracer } = await createTracer({
 *   config: {
 *     publicKey: 'pk-lf-...',
 *     secretKey: 'sk-lf-...',
 *     baseUrl: 'https://cloud.langfuse.com',
 *   },
 * });
 * ```
 */
export async function createTracer(
  options: TracerFactoryOptions = {}
): Promise<TracerFactoryResult> {
  const { config: configOverrides, configFile, autoInitialize = true, singleton = true } = options;

  // Return existing singleton if available
  if (singleton && globalTracer) {
    return buildResult(globalTracer, globalTracer['client'] !== null);
  }

  // Build config from env + file + overrides
  const config = createConfig({
    ...(configFile ? mergeConfigFile(configFile) : {}),
    ...configOverrides,
  });

  // Create the tracer
  const tracer = new AgentTracer(config);

  // Auto-initialize
  if (autoInitialize) {
    await tracer.initialize();
  }

  // Store as singleton
  if (singleton) {
    globalTracer = tracer;
  }

  return buildResult(tracer, autoInitialize);
}

// ---------------------------------------------------------------------------
// createTracerSync — Synchronous factory (no auto-init)
// -------------------------------------------------------------------------

/**
 * Create a tracer without auto-initialization.
 * Useful when you want to control initialization timing.
 */
export function createTracerSync(
  options: Omit<TracerFactoryOptions, 'autoInitialize'> = {}
): TracerFactoryResult {
  const { config: configOverrides, configFile, singleton = true } = options;

  // Return existing singleton if available
  if (singleton && globalTracer) {
    return buildResult(globalTracer, false);
  }

  // Build config from env + file + overrides
  const config = createConfig({
    ...(configFile ? mergeConfigFile(configFile) : {}),
    ...configOverrides,
  });

  // Create the tracer
  const tracer = new AgentTracer(config);

  // Store as singleton
  if (singleton) {
    globalTracer = tracer;
  }

  return buildResult(tracer, false);
}

// ---------------------------------------------------------------------------
// getGlobalTracer — Get the global tracer instance
// ---------------------------------------------------------------------------

/**
 * Get the global tracer instance (if created with singleton: true).
 */
export function getGlobalTracer(): AgentTracer | null {
  return globalTracer;
}

// ---------------------------------------------------------------------------
// resetGlobalTracer — Reset the global singleton (for testing)
// ---------------------------------------------------------------------------

/**
 * Reset the global tracer instance. Useful for testing.
 */
export async function resetGlobalTracer(): Promise<void> {
  if (globalTracer) {
    await globalTracer.shutdown();
    globalTracer = null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildResult(tracer: AgentTracer, _initialized: boolean): TracerFactoryResult {
  return {
    tracer,
    config: tracer.getConfig(),
    createMiddleware: (options?: Partial<MiddlewareOptions>) =>
      new TracingMiddleware(tracer, options),
    shutdown: async () => {
      await tracer.shutdown();
      if (globalTracer === tracer) {
        globalTracer = null;
      }
    },
  };
}

function mergeConfigFile(configFile: TracingConfigFile): Partial<TracingConfig> {
  const lf = configFile.langfuse;
  if (!lf) return {};

  const config: Partial<TracingConfig> = {};

  if (lf.publicKey) config.publicKey = lf.publicKey;
  if (lf.secretKey) config.secretKey = lf.secretKey;
  if (lf.baseUrl) config.baseUrl = lf.baseUrl;
  if (lf.enabled !== undefined) config.enabled = lf.enabled;
  if (lf.debug !== undefined) config.debug = lf.debug;
  if (lf.tags) config.tags = lf.tags;
  if (lf.release) config.release = lf.release;
  if (lf.flushInterval !== undefined) config.flushInterval = lf.flushInterval;
  if (lf.batchSize !== undefined) config.batchSize = lf.batchSize;
  if (lf.requestTimeout !== undefined) config.requestTimeout = lf.requestTimeout;
  if (lf.maxRetries !== undefined) config.maxRetries = lf.maxRetries;
  if (lf.metadata) config.metadata = lf.metadata;

  return config;
}
