/**
 * @oa/config — Configuration Management for OvolveAgent
 *
 * Provides configuration loading, validation, and default values.
 * Uses Zod for schema validation.
 *
 * @example
 * ```ts
 * import { loadConfig, getDefaultConfig, validateConfig } from '@oa/config';
 *
 * const config = loadConfig('./ovolveagent.config.ts');
 * const defaultConfig = getDefaultConfig();
 * const result = validateConfig(userConfig);
 * ```
 */

import { z } from 'zod';

// ===========================================================================
// Zod Schemas
// ===========================================================================

const StorageConfigSchema = z.object({
  dbPath: z.string().default('./data/ovolveagent.db'),
  busyTimeout: z.number().default(5000),
  walMode: z.boolean().default(true),
  foreignKeys: z.boolean().default(true),
  autoMigrate: z.boolean().default(true),
  pragmas: z.record(z.union([z.string(), z.number()])).optional(),
});

const LlmProviderConfigSchema = z.object({
  id: z.string(),
  type: z.enum(['openai', 'anthropic', 'google', 'deepseek', 'bedrock', 'azure', 'custom']),
  apiKey: z.string(),
  baseUrl: z.string().url().optional(),
  region: z.string().optional(),
  deployment: z.string().optional(),
  apiVersion: z.string().optional(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    contextWindow: z.number(),
    maxTokens: z.number(),
    inputTypes: z.array(z.enum(['text', 'image', 'audio', 'video'])),
    supportsStreaming: z.boolean(),
    supportsTools: z.boolean(),
    supportsThinking: z.boolean(),
    supportsVision: z.boolean(),
    costPer1mTokens: z.object({ input: z.number(), output: z.number() }),
    status: z.enum(['active', 'deprecated', 'maintenance']).default('active'),
  })),
  timeout: z.number().default(120_000),
  maxRetries: z.number().default(5),
  enabled: z.boolean().default(true),
  priority: z.number().default(0),
  extraHeaders: z.record(z.string()).optional(),
});

const LlmConfigSchema = z.object({
  providers: z.array(LlmProviderConfigSchema).default([]),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
});

const MemoryConfigSchema = z.object({
  dbPath: z.string().optional(),
  embeddingModel: z.string().default('BAAI/bge-base-zh-v1.5'),
  embeddingDimensions: z.number().default(768),
  embeddingCacheSize: z.number().default(4096),
  extractionDebounceMs: z.number().default(60000),
  defaultRecallLimit: z.number().default(10),
  overFetchMultiplier: z.number().default(4),
  mmrLambda: z.number().default(0.7),
  driftThresholdDays: z.number().default(90),
  decayHalfLifeDays: z.number().default(30),
  workspaceRoot: z.string().optional(),
});

const SecurityConfigSchema = z.object({
  permissionMode: z.enum(['PLAN', 'READ_ONLY', 'CONFIRM', 'AUTO', 'FULL']).default('CONFIRM'),
  workspaceRoot: z.string().default(process.cwd()),
  userHome: z.string().default(process.env.HOME ?? process.env.USERPROFILE ?? ''),
  isRoot: z.boolean().default(false),
  allowRootEscalation: z.boolean().default(false),
  checkInjection: z.boolean().default(true),
  redactSecrets: z.boolean().default(true),
});

const PluginConfigSchema = z.object({
  resolveDependencies: z.boolean().default(true),
  allowDuplicateNames: z.boolean().default(false),
  pluginPaths: z.array(z.string()).default([]),
  disabledPlugins: z.array(z.string()).default([]),
});

const ToolConfigSchema = z.object({
  maxConcurrency: z.number().default(8),
  defaultTimeoutMs: z.number().default(30000),
  recordHistory: z.boolean().default(true),
  maxHistoryEntries: z.number().default(1000),
});

const AgentLoopConfigSchema = z.object({
  maxSteps: z.number().default(25),
  maxToolCallsPerStep: z.number().default(50),
  toolExecutionMode: z.enum(['parallel', 'sequential']).default('parallel'),
  maxParallelTools: z.number().default(8),
  turnTimeout: z.number().default(600_000),
  systemPrompt: z.string().default('You are OvolveAgent, a helpful AI assistant.'),
  enableMemoryInjection: z.boolean().default(true),
  enableSkillInjection: z.boolean().default(true),
});

const EventStoreConfigSchema = z.object({
  autoSnapshot: z.boolean().default(true),
  snapshotInterval: z.number().default(100),
});

const McpConfigSchema = z.object({
  servers: z.record(z.object({
    name: z.string(),
    description: z.string().optional(),
    transport: z.union([
      z.object({ type: z.literal('stdio'), command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string()).optional(), cwd: z.string().optional() }),
      z.object({ type: z.literal('http'), url: z.string().url(), headers: z.record(z.string()).optional(), timeout: z.number().optional() }),
      z.object({ type: z.literal('sse'), url: z.string().url(), headers: z.record(z.string()).optional(), reconnectInterval: z.number().optional() }),
      z.object({ type: z.literal('websocket'), url: z.string().url(), headers: z.record(z.string()).optional(), protocols: z.array(z.string()).optional() }),
    ]),
    enabled: z.boolean().default(true),
    timeout: z.number().default(30000),
    heartbeatInterval: z.number().default(30000),
    heartbeatTimeout: z.number().default(10000),
    retries: z.number().default(3),
    metadata: z.record(z.unknown()).optional(),
  })).default({}),
  defaultTimeout: z.number().default(30000),
  defaultHeartbeatInterval: z.number().default(30000),
  defaultHeartbeatTimeout: z.number().default(10000),
  enabled: z.boolean().default(true),
});

const SessionConfigSchema = z.object({
  maxSessions: z.number().default(100),
  sessionTimeout: z.number().default(3_600_000), // 1 hour
  autoArchive: z.boolean().default(true),
  archiveAfterDays: z.number().default(30),
});

const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  file: z.string().optional(),
  console: z.boolean().default(true),
  format: z.enum(['json', 'text']).default('json'),
});

const UiConfigSchema = z.object({
  theme: z.enum(['light', 'dark', 'auto']).default('auto'),
  language: z.string().default('en'),
  animationsEnabled: z.boolean().default(true),
  sidebarCollapsed: z.boolean().default(false),
});

const ElectronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  windowWidth: z.number().default(1200),
  windowHeight: z.number().default(800),
  resizable: z.boolean().default(true),
  title: z.string().default('OvolveAgent'),
});

const CompactionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  strategy: z.enum(['sliding_window', 'summarization', 'hybrid']).default('hybrid'),
  maxContextTokens: z.number().default(80_000),
  compactionThreshold: z.number().default(0.8), // 80% of context window
  preserveRecentMessages: z.number().default(10),
});

const RecoveryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxRetries: z.number().default(3),
  retryDelayMs: z.number().default(1000),
  enableCheckpoints: z.boolean().default(true),
  checkpointIntervalMs: z.number().default(60_000), // 1 minute
});

// ─── Root Config Schema ───────────────────────────────────────────────────

export const OvolveAgentConfigSchema = z.object({
  storage: StorageConfigSchema.default({}),
  llm: LlmConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  plugins: PluginConfigSchema.default({}),
  tools: ToolConfigSchema.default({}),
  agentLoop: AgentLoopConfigSchema.default({}),
  eventStore: EventStoreConfigSchema.default({}),
  mcp: McpConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  ui: UiConfigSchema.default({}),
  electron: ElectronConfigSchema.default({}),
  compaction: CompactionConfigSchema.default({}),
  recovery: RecoveryConfigSchema.default({}),
});

// ===========================================================================
// Type Definitions
// ===========================================================================

export type OvolveAgentConfig = z.infer<typeof OvolveAgentConfigSchema>;
export type StorageConfig = z.infer<typeof StorageConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type ToolConfig = z.infer<typeof ToolConfigSchema>;
export type AgentLoopConfig = z.infer<typeof AgentLoopConfigSchema>;
export type EventStoreConfig = z.infer<typeof EventStoreConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type UiConfig = z.infer<typeof UiConfigSchema>;
export type ElectronConfig = z.infer<typeof ElectronConfigSchema>;
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
export type RecoveryConfig = z.infer<typeof RecoveryConfigSchema>;

// ===========================================================================
// Default Configuration
// ===========================================================================

/**
 * Get the default OvolveAgent configuration.
 */
export function getDefaultConfig(): OvolveAgentConfig {
  return OvolveAgentConfigSchema.parse({});
}

// ===========================================================================
// Configuration Validation
// ===========================================================================

export interface ConfigValidationResult {
  success: boolean;
  config?: OvolveAgentConfig;
  errors?: ConfigError[];
}

export interface ConfigError {
  path: string;
  message: string;
  value?: unknown;
}

/**
 * Validate a configuration object against the schema.
 */
export function validateConfig(config: unknown): ConfigValidationResult {
  const result = OvolveAgentConfigSchema.safeParse(config);

  if (result.success) {
    return { success: true, config: result.data };
  }

  const errors: ConfigError[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    value: issue.path.reduce((obj: unknown, key) => {
      if (obj && typeof obj === 'object') {
        return (obj as Record<string, unknown>)[key as string];
      }
      return undefined;
    }, config),
  }));

  return { success: false, errors };
}

// ===========================================================================
// Configuration Loading
// ===========================================================================

/**
 * Load configuration from a file path.
 * Supports TypeScript, JSON, and JSON5 formats.
 *
 * @param path - Path to the configuration file
 * @returns Validated configuration object
 */
export async function loadConfig(path: string): Promise<OvolveAgentConfig> {
  let config: unknown;

  if (path.endsWith('.ts') || path.endsWith('.tsx')) {
    // Dynamic import for TypeScript config files
    const module = await import(path);
    config = module.default ?? module.config ?? module;
  } else if (path.endsWith('.json') || path.endsWith('.json5')) {
    // Read and parse JSON config files
    const { readFile } = await import('fs/promises');
    const content = await readFile(path, 'utf-8');
    config = JSON.parse(content);
  } else {
    throw new Error(`Unsupported config file format: ${path}`);
  }

  const result = validateConfig(config);
  if (!result.success || !result.config) {
    throw new Error(
      `Invalid configuration: ${result.errors?.map((e) => `${e.path}: ${e.message}`).join(', ')}`
    );
  }

  return result.config;
}

/**
 * Load configuration from a partial object.
 * Missing values are filled with defaults.
 */
export function loadPartialConfig(partial: Partial<OvolveAgentConfig>): OvolveAgentConfig {
  return OvolveAgentConfigSchema.parse(partial);
}

/**
 * Merge multiple configuration objects.
 * Later values override earlier ones.
 */
export function mergeConfigs(...configs: Partial<OvolveAgentConfig>[]): OvolveAgentConfig {
  const merged: Record<string, unknown> = {};

  for (const config of configs) {
    for (const [key, value] of Object.entries(config)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        merged[key] = { ...(merged[key] as Record<string, unknown>), ...value };
      } else {
        merged[key] = value;
      }
    }
  }

  return OvolveAgentConfigSchema.parse(merged);
}

/**
 * Save configuration to a JSON file.
 */
export async function saveConfig(config: OvolveAgentConfig, path: string): Promise<void> {
  const { writeFile } = await import('fs/promises');
  await writeFile(path, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Convert config to JSON string.
 */
export function configToJson(config: OvolveAgentConfig): string {
  return JSON.stringify(config, null, 2);
}

/**
 * Parse config from JSON string.
 */
export function configFromJson(json: string): OvolveAgentConfig {
  const parsed = JSON.parse(json);
  const result = validateConfig(parsed);
  if (!result.success || !result.config) {
    throw new Error(
      `Invalid configuration JSON: ${result.errors?.map((e) => `${e.path}: ${e.message}`).join(', ')}`
    );
  }
  return result.config;
}

// ===========================================================================
// Environment-based Configuration
// ===========================================================================

/**
 * Load configuration from environment variables.
 * All values are prefixed with OVOLVEAGENT_.
 */
export function loadConfigFromEnv(): Partial<OvolveAgentConfig> {
  const env = process.env;
  const config: Record<string, unknown> = {};

  // Storage
  if (env.OVOLVEAGENT_DB_PATH) {
    config.storage = { dbPath: env.OVOLVEAGENT_DB_PATH };
  }

  // LLM
  if (env.OVOLVEAGENT_API_KEY) {
    config.llm = {
      providers: [{
        id: env.OVOLVEAGENT_PROVIDER_ID ?? 'default',
        type: (env.OVOLVEAGENT_PROVIDER_TYPE ?? 'openai') as 'openai' | 'anthropic' | 'google' | 'deepseek' | 'bedrock' | 'azure' | 'custom',
        apiKey: env.OVOLVEAGENT_API_KEY,
        baseUrl: env.OVOLVEAGENT_BASE_URL,
        models: [],
        timeout: 120_000,
        maxRetries: 5,
        enabled: true,
        priority: 0,
      }],
      defaultProvider: env.OVOLVEAGENT_PROVIDER_ID ?? 'default',
      defaultModel: env.OVOLVEAGENT_MODEL,
    };
  }

  // Security
  if (env.OVOLVEAGENT_PERMISSION_MODE) {
    config.security = {
      permissionMode: env.OVOLVEAGENT_PERMISSION_MODE as 'PLAN' | 'READ_ONLY' | 'CONFIRM' | 'AUTO' | 'FULL',
    };
  }

  // Logging
  if (env.OVOLVEAGENT_LOG_LEVEL) {
    config.logging = {
      level: env.OVOLVEAGENT_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error',
    };
  }

  return config as Partial<OvolveAgentConfig>;
}

// ===========================================================================
// Config Path Helpers
// ===========================================================================

/**
 * Get the default config file path.
 */
export function getDefaultConfigPath(): string {
  return './ovolveagent.config.json';
}

/**
 * Get the data directory path from config.
 */
export function getDataDir(config: OvolveAgentConfig): string {
  return config.storage.dbPath
    ? require('path').dirname(config.storage.dbPath)
    : './data';
}

/**
 * Check if running in development mode.
 */
export function isDevMode(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.OVOLVEAGENT_DEV === 'true';
}

/**
 * Check if running in production mode.
 */
export function isProdMode(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.OVOLVEAGENT_DEV !== 'true';
}
