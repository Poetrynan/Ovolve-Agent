/**
 * @oa/plugins — Core types
 *
 * Plugin microkernel and hook dispatch for OvolveAgent.
 * Plugins can hook into lifecycle events, emit events, and provide
 * middleware for tool execution and LLM requests.
 */

/**
 * The nine hook points in the OvolveAgent lifecycle.
 * Plugins subscribe to these to intercept and transform behavior.
 */
export enum HookPoint {
  /** Fired before a tool is executed. Can block or modify the call. */
  PRE_TOOL_USE = 'PRE_TOOL_USE',
  /** Fired after a tool executes. Can transform or annotate the result. */
  POST_TOOL_USE = 'POST_TOOL_USE',
  /** Fired before a request is sent to the LLM. Can modify the request. */
  PRE_LLM_REQUEST = 'PRE_LLM_REQUEST',
  /** Fired after a response is received from the LLM. Can modify the response. */
  POST_LLM_RESPONSE = 'POST_LLM_RESPONSE',
  /** Fired before context folding (compaction) begins. */
  PRE_FOLD = 'PRE_FOLD',
  /** Fired after context folding completes. */
  POST_FOLD = 'POST_FOLD',
  /** Fired when a new session starts. */
  SESSION_START = 'SESSION_START',
  /** Fired when a session ends. */
  SESSION_END = 'SESSION_END',
  /** Fired when a sub-agent stops. */
  SUBAGENT_STOP = 'SUBAGENT_STOP',
}

/**
 * Risk levels for tools and plugin operations.
 */
export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

/**
 * Context passed to every plugin hook handler.
 * Provides access to the session, environment, and shared services.
 */
export interface PluginContext {
  /** Unique session identifier. */
  sessionId: string;
  /** Current agent identifier. */
  agentId: string;
  /** User identifier if authenticated. */
  userId?: string;
  /** Arbitrary metadata bag for cross-plugin communication. */
  metadata: Record<string, unknown>;
  /** Abort signal for cancellation propagation. */
  signal?: AbortSignal;
  /** Logger instance scoped to the current operation. */
  logger: Logger;
}

/**
 * Minimal logger interface. Plugins should depend on this abstraction
 * rather than `console` to allow structured logging integration.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * A hook handler function that receives a payload and optionally
 * transforms it, blocks the operation, or triggers side effects.
 */
export type HookHandler<T = unknown> = (
  payload: T,
  context: PluginContext
) => Promise<T | HookControl> | T | HookControl;

/**
 * Control object returned by hook handlers to influence pipeline behavior.
 */
export interface HookControl {
  /** If true, the operation is blocked and an error is raised. */
  blocked: boolean;
  /** Optional reason for blocking. */
  reason?: string;
  /** Optional replacement payload. */
  payload?: unknown;
}

/**
 * Internal representation of a registered hook subscription.
 */
export interface HookSubscription {
  /** Unique identifier for this subscription. */
  id: string;
  /** The hook point this subscription targets. */
  hookPoint: HookPoint;
  /** The handler function. */
  handler: HookHandler;
  /** Priority — lower numbers run first. Default 100. */
  priority: number;
  /** The name of the plugin that registered this hook. */
  pluginName: string;
  /** Whether this handler is async. */
  async: boolean;
}

/**
 * Lifecycle methods a plugin may implement.
 */
export interface PluginLifecycle {
  /** Called once when the plugin is loaded. Use for initialization. */
  onLoad?(context: PluginContext): Promise<void> | void;
  /** Called once when the plugin is unloaded. Use for cleanup. */
  onUnload?(context: PluginContext): Promise<void> | void;
  /** Called when the plugin's health check is invoked. */
  onHealthCheck?(): Promise<HealthStatus> | HealthStatus;
}

/**
 * Health status returned by a plugin's health check.
 */
export interface HealthStatus {
  healthy: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Metadata describing a plugin.
 */
export interface PluginManifest {
  /** Unique plugin name. */
  name: string;
  /** Semantic version. */
  version: string;
  /** Human-readable description. */
  description?: string;
  /** Plugin author. */
  author?: string;
  /** Names of plugins this plugin depends on. */
  dependencies?: string[];
  /** Hook points this plugin intends to subscribe to. */
  hookPoints?: HookPoint[];
  /** Default risk level of this plugin's operations. */
  riskLevel?: RiskLevel;
}

/**
 * The core plugin interface. Every plugin must implement this.
 */
export interface IPlugin extends PluginLifecycle {
  /** Static manifest metadata. */
  readonly manifest: PluginManifest;
  /**
   * Register hooks into the plugin manager. Called during load.
   * Use the provided registry to subscribe to hook points.
   */
  register(registry: HookRegistry, context: PluginContext): Promise<void> | void;
}

/**
 * Registry interface passed to plugins during registration.
 * Allows plugins to subscribe to hook points.
 */
export interface HookRegistry {
  /**
   * Subscribe a handler to a hook point.
   * @param hookPoint The lifecycle hook point.
   * @param handler The handler function.
   * @param priority Lower numbers execute first. Default 100.
   */
  on<T = unknown>(hookPoint: HookPoint, handler: HookHandler<T>, priority?: number): void;
}

/**
 * Internal record of a loaded plugin.
 */
export interface LoadedPlugin {
  plugin: IPlugin;
  subscriptions: HookSubscription[];
  loadedAt: Date;
  status: PluginStatus;
}

/**
 * Status of a loaded plugin.
 */
export enum PluginStatus {
  REGISTERED = 'REGISTERED',
  LOADING = 'LOADING',
  ACTIVE = 'ACTIVE',
  UNLOADING = 'UNLOADING',
  ERROR = 'ERROR',
}

/**
 * Configuration for the PluginManager factory.
 */
export interface PluginManagerConfig {
  /** Shared logger instance. */
  logger?: Logger;
  /** Whether to automatically resolve and sort dependencies. */
  resolveDependencies?: boolean;
  /** Whether to allow multiple plugins with the same name. */
  allowDuplicateNames?: boolean;
  /** Default abort signal for operations. */
  defaultSignal?: AbortSignal;
  /** Optional event store integration callback. */
  onEvent?: (event: PluginEvent) => void;
}

/**
 * Event emitted by the plugin system.
 */
export interface PluginEvent {
  type: string;
  source: string;
  timestamp: Date;
  payload?: unknown;
}

/**
 * Options for the waterfall middleware execution.
 */
export interface WaterfallOptions {
  /** Whether to short-circuit on the first control signal. */
  shortCircuit?: boolean;
  /** Timeout in milliseconds for the entire waterfall. */
  timeoutMs?: number;
}

/**
 * Result of a plugin load operation.
 */
export interface LoadResult {
  pluginName: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

/**
 * Result of dependency resolution.
 */
export interface DependencyResolution {
  order: string[];
  missing: string[];
  circular: string[][];
}
