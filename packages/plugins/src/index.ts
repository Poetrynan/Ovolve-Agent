/**
 * @oa/plugins — Plugin System for OvolveAgent
 *
 * Plugin microkernel and hook dispatch for OvolveAgent.
 * Provides lifecycle hooks, dependency resolution, and event dispatch.
 */

// ─── Core Types ───────────────────────────────────────────────────────────
export {
  HookPoint,
  RiskLevel,
  PluginStatus,
  type IPlugin,
  type PluginContext,
  type PluginManifest,
  type PluginLifecycle,
  type PluginManagerConfig,
  type PluginEvent,
  type HookHandler,
  type HookControl,
  type HookRegistry,
  type HookSubscription,
  type LoadedPlugin,
  type LoadResult,
  type DependencyResolution,
  type WaterfallOptions,
  type HealthStatus,
  type Logger,
} from './types';

// ─── Plugin Manager ───────────────────────────────────────────────────────
export {
  PluginManager,
  createPluginManager,
} from './plugin-manager';

// ─── Hook Runner ──────────────────────────────────────────────────────────
export {
  HookRunner,
  generateSubscriptionId,
  HookCriticalError,
  type HookResult,
  type HookError,
} from './hook-runner';

// ─── Built-in Plugins ─────────────────────────────────────────────────────
export {
  RiskControlPlugin,
  createRiskControlPlugin,
  type RiskControlConfig,
  type AuditEntry,
  type ToolUsePayload as RiskToolUsePayload,
} from './built-in/risk-control';

export {
  MemoryLayerPlugin,
  InMemoryStore,
  MemoryCategory,
  createMemoryLayerPlugin,
  type MemoryLayerConfig,
  type MemoryStore,
  type MemoryEntry,
  type InjectedMemoryContext,
  type LLMRequestPayload,
} from './built-in/memory-layer';

export {
  CompactionPlugin,
  CompactionStrategy,
  createCompactionPlugin,
  type CompactionConfig,
  type CompactionMessage,
  type CompactionResult,
  type PreFoldPayload,
  type PostFoldPayload,
} from './built-in/compaction';

export {
  SecurityPlugin,
  createSecurityPlugin,
  type SecurityConfig,
  type SecurityRule,
  type SecurityEvent,
  type ToolUsePayload as SecurityToolUsePayload,
} from './built-in/security';
