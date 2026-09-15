/**
 * @oa/tracing — Configuration Management
 *
 * Loads and validates tracing configuration from environment variables,
 * config files, and runtime overrides. Supports both cloud and self-hosted
 * Langfuse deployments.
 *
 * Environment variables:
 *   - LANGFUSE_PUBLIC_KEY  — Langfuse public key (pk-lf-...)
 *   - LANGFUSE_SECRET_KEY  — Langfuse secret key (sk-lf-...)
 *   - LANGFUSE_HOST        — Langfuse base URL (default: https://cloud.langfuse.com)
 *   - LANGFUSE_ENABLED     — Whether tracing is enabled (default: true)
 *   - LANGFUSE_DEBUG       — Enable debug logging (default: false)
 *   - LANGFUSE_TAGS        — Comma-separated tags
 *   - LANGFUSE_RELEASE     — Release identifier
 */

import type { TracingConfig, LangfuseDeploymentMode } from './types';
import { DEFAULT_TRACING_CONFIG } from './types';

// ---------------------------------------------------------------------------
// Config source types
// ---------------------------------------------------------------------------

export interface ConfigSource {
  name: string;
  priority: number;
  load(): Partial<TracingConfig>;
}

// ---------------------------------------------------------------------------
// Environment variable loader
// ---------------------------------------------------------------------------

const ENV_PREFIX = 'LANGFUSE_';

export function loadFromEnv(): Partial<TracingConfig> {
  const config: Partial<TracingConfig> = {};

  const publicKey = process.env[`${ENV_PREFIX}PUBLIC_KEY`];
  const secretKey = process.env[`${ENV_PREFIX}SECRET_KEY`];
  const host = process.env[`${ENV_PREFIX}HOST`];
  const enabled = process.env[`${ENV_PREFIX}ENABLED`];
  const debug = process.env[`${ENV_PREFIX}DEBUG`];
  const tags = process.env[`${ENV_PREFIX}TAGS`];
  const release = process.env[`${ENV_PREFIX}RELEASE`];
  const flushInterval = process.env[`${ENV_PREFIX}FLUSH_INTERVAL`];
  const batchSize = process.env[`${ENV_PREFIX}BATCH_SIZE`];
  const requestTimeout = process.env[`${ENV_PREFIX}REQUEST_TIMEOUT`];
  const maxRetries = process.env[`${ENV_PREFIX}MAX_RETRIES`];

  if (publicKey) {
    config.publicKey = publicKey;
  }
  if (secretKey) {
    config.secretKey = secretKey;
  }
  if (host) {
    config.baseUrl = host;
  }
  if (enabled !== undefined) {
    config.enabled = enabled.toLowerCase() === 'true' || enabled === '1';
  }
  if (debug !== undefined) {
    config.debug = debug.toLowerCase() === 'true' || debug === '1';
  }
  if (tags) {
    config.tags = tags.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (release) {
    config.release = release;
  }
  if (flushInterval) {
    const parsed = parseInt(flushInterval, 10);
    if (!isNaN(parsed)) config.flushInterval = parsed;
  }
  if (batchSize) {
    const parsed = parseInt(batchSize, 10);
    if (!isNaN(parsed)) config.batchSize = parsed;
  }
  if (requestTimeout) {
    const parsed = parseInt(requestTimeout, 10);
    if (!isNaN(parsed)) config.requestTimeout = parsed;
  }
  if (maxRetries) {
    const parsed = parseInt(maxRetries, 10);
    if (!isNaN(parsed)) config.maxRetries = parsed;
  }

  // Determine deployment mode from host
  if (host) {
    config.mode = detectDeploymentMode(host);
  } else if (publicKey || secretKey) {
    config.mode = 'cloud';
  }

  return config;
}

// ---------------------------------------------------------------------------
// File-based config loader
// ---------------------------------------------------------------------------

export interface TracingConfigFile {
  langfuse?: {
    publicKey?: string;
    secretKey?: string;
    baseUrl?: string;
    enabled?: boolean;
    debug?: boolean;
    tags?: string[];
    release?: string;
    flushInterval?: number;
    batchSize?: number;
    requestTimeout?: number;
    maxRetries?: number;
    metadata?: Record<string, unknown>;
  };
}

export function loadFromFile(file: TracingConfigFile): Partial<TracingConfig> {
  const lf = file.langfuse;
  if (!lf) return {};

  const config: Partial<TracingConfig> = {};

  if (lf.publicKey) config.publicKey = lf.publicKey;
  if (lf.secretKey) config.secretKey = lf.secretKey;
  if (lf.baseUrl) {
    config.baseUrl = lf.baseUrl;
    config.mode = detectDeploymentMode(lf.baseUrl);
  }
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

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

export class TracingConfigBuilder {
  private config: Partial<TracingConfig> = {};

  constructor() {
    // Start with defaults
    this.config = { ...DEFAULT_TRACING_CONFIG };
  }

  /**
   * Load from environment variables.
   */
  fromEnv(): this {
    const envConfig = loadFromEnv();
    this.merge(envConfig);
    return this;
  }

  /**
   * Load from a config file object.
   */
  fromFile(file: TracingConfigFile): this {
    const fileConfig = loadFromFile(file);
    this.merge(fileConfig);
    return this;
  }

  /**
   * Set a specific value.
   */
  set<K extends keyof TracingConfig>(key: K, value: TracingConfig[K]): this {
    this.config[key] = value;
    return this;
  }

  /**
   * Set the public key.
   */
  publicKey(key: string): this {
    this.config.publicKey = key;
    return this;
  }

  /**
   * Set the secret key.
   */
  secretKey(key: string): this {
    this.config.secretKey = key;
    return this;
  }

  /**
   * Set the base URL.
   */
  baseUrl(url: string): this {
    this.config.baseUrl = url;
    this.config.mode = detectDeploymentMode(url);
    return this;
  }

  /**
   * Set the deployment mode explicitly.
   */
  mode(mode: LangfuseDeploymentMode): this {
    this.config.mode = mode;
    return this;
  }

  /**
   * Enable or disable tracing.
   */
  enabled(enabled: boolean): this {
    this.config.enabled = enabled;
    return this;
  }

  /**
   * Set debug mode.
   */
  debug(debug: boolean): this {
    this.config.debug = debug;
    return this;
  }

  /**
   * Set tags.
   */
  tags(tags: string[]): this {
    this.config.tags = tags;
    return this;
  }

  /**
   * Set release identifier.
   */
  release(release: string): this {
    this.config.release = release;
    return this;
  }

  /**
   * Set flush interval.
   */
  flushInterval(ms: number): this {
    this.config.flushInterval = ms;
    return this;
  }

  /**
   * Set batch size.
   */
  batchSize(size: number): this {
    this.config.batchSize = size;
    return this;
  }

  /**
   * Set request timeout.
   */
  requestTimeout(ms: number): this {
    this.config.requestTimeout = ms;
    return this;
  }

  /**
   * Set max retries.
   */
  maxRetries(retries: number): this {
    this.config.maxRetries = retries;
    return this;
  }

  /**
   * Set custom metadata.
   */
  metadata(metadata: Record<string, unknown>): this {
    this.config.metadata = { ...this.config.metadata, ...metadata };
    return this;
  }

  /**
   * Merge a partial config.
   */
  merge(partial: Partial<TracingConfig>): this {
    this.config = { ...this.config, ...partial };
    return this;
  }

  /**
   * Build the final config. Validates required fields.
   */
  build(): TracingConfig {
    return validateConfig(this.config);
  }

  /**
   * Build without validation (for partial configs).
   */
  buildPartial(): Partial<TracingConfig> {
    return { ...this.config };
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

export function validateConfig(config: Partial<TracingConfig>): TracingConfig {
  const errors: string[] = [];

  // Required fields
  if (!config.publicKey) {
    errors.push('publicKey is required');
  } else if (!config.publicKey.startsWith('pk-lf-')) {
    errors.push('publicKey must start with "pk-lf-"');
  }

  if (!config.secretKey) {
    errors.push('secretKey is required');
  } else if (!config.secretKey.startsWith('sk-lf-')) {
    errors.push('secretKey must start with "sk-lf-"');
  }

  if (!config.baseUrl) {
    errors.push('baseUrl is required');
  } else {
    try {
      new URL(config.baseUrl);
    } catch {
      errors.push('baseUrl must be a valid URL');
    }
  }

  // Numeric validations
  if (config.flushInterval !== undefined && config.flushInterval < 1000) {
    errors.push('flushInterval must be at least 1000ms');
  }

  if (config.batchSize !== undefined && config.batchSize < 1) {
    errors.push('batchSize must be at least 1');
  }

  if (config.requestTimeout !== undefined && config.requestTimeout < 1000) {
    errors.push('requestTimeout must be at least 1000ms');
  }

  if (config.maxRetries !== undefined && config.maxRetries < 0) {
    errors.push('maxRetries must be non-negative');
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }

  return {
    ...DEFAULT_TRACING_CONFIG,
    ...config,
  } as TracingConfig;
}

// ---------------------------------------------------------------------------
// Config validation error
// ---------------------------------------------------------------------------

export class ConfigValidationError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(`Tracing config validation failed: ${errors.join('; ')}`);
    this.name = 'ConfigValidationError';
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Detect deployment mode from base URL.
 */
export function detectDeploymentMode(baseUrl: string): LangfuseDeploymentMode {
  const cloudHosts = [
    'cloud.langfuse.com',
    'eu.cloud.langfuse.com',
    'us.cloud.langfuse.com',
  ];

  try {
    const url = new URL(baseUrl);
    return cloudHosts.includes(url.hostname) ? 'cloud' : 'self-hosted';
  } catch {
    return 'cloud';
  }
}

/**
 * Create a config from environment variables with optional overrides.
 */
export function createConfig(overrides: Partial<TracingConfig> = {}): TracingConfig {
  return new TracingConfigBuilder()
    .fromEnv()
    .merge(overrides)
    .build();
}

/**
 * Create a config without validation (for testing or partial setups).
 */
export function createConfigUnsafe(
  overrides: Partial<TracingConfig> = {}
): Partial<TracingConfig> {
  return new TracingConfigBuilder()
    .fromEnv()
    .merge(overrides)
    .buildPartial();
}

/**
 * Check if the current environment has Langfuse credentials configured.
 */
export function hasLangfuseCredentials(): boolean {
  return Boolean(
    process.env[`${ENV_PREFIX}PUBLIC_KEY`] && process.env[`${ENV_PREFIX}SECRET_KEY`]
  );
}

/**
 * Get a human-readable summary of the config (with secrets redacted).
 */
export function summarizeConfig(config: TracingConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    baseUrl: config.baseUrl,
    publicKey: config.publicKey ? `${config.publicKey.slice(0, 8)}...` : undefined,
    secretKey: config.secretKey ? '[REDACTED]' : undefined,
    enabled: config.enabled,
    debug: config.debug,
    flushInterval: config.flushInterval,
    batchSize: config.batchSize,
    requestTimeout: config.requestTimeout,
    maxRetries: config.maxRetries,
    release: config.release,
    tags: config.tags,
    metadata: config.metadata,
  };
}
