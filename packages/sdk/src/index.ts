/**
 * @oa/sdk — SDK for OvolveAgent Plugin Development
 *
 * Provides utilities and type definitions for building plugins and tools
 * that integrate with OvolveAgent.
 */

// Re-export core types
export type {
  IPlugin,
  PluginContext,
  PluginManifest,
  HookPoint,
  RiskLevel,
  HookHandler,
  HookControl,
} from '@oa/plugins';

export type {
  ToolDefinition,
  ToolResult,
  ToolCall,
  ToolExecutionContext,
  ToolContent,
  InputSchema,
  ToolExecutionMode,
  ToolScope,
} from '@oa/tools';

export type {
  AgentLoopConfig,
  SessionState,
  TurnOptions,
  StepResult,
  TurnResult,
  AgentEvent,
} from '@oa/agent-loop';

export type {
  LlmRequest,
  LlmResponse,
  LlmMessage,
  TokenUsage,
  ThinkingLevel,
} from '@oa/llm';

export type {
  MemoryTier,
  MemoryType,
  MemoryScope,
  MemoryEntry,
  RecallOptions,
  RecallOutcome,
} from '@oa/memory';

export type {
  SecurityPipelineConfig,
  PipelineResult,
  PermissionMode,
  Verdict,
} from '@oa/security';

// Re-export factory functions
export { createPluginManager, PluginManager } from '@oa/plugins';
export { createToolRegistry, ToolRegistry } from '@oa/tools';
export { createAgentLoop, AgentLoop } from '@oa/agent-loop';
export { createLlmClient, LlmClient } from '@oa/llm';
export { createMemoryLayer, MemoryLayer } from '@oa/memory';
export { createSecurityPipeline, SecurityPipeline } from '@oa/security';
export { createEventStore, EventStore } from '@oa/event-store';
export { createStorage, DatabaseManager } from '@oa/storage';
export { createSessionManager } from '@oa/session-core';
export { createProjectionEngine } from '@oa/projection';
export { createRecoveryManager } from '@oa/recovery';
export { createCompactor } from '@oa/compaction';
export { createSkillManager } from '@oa/skills';
export { createEvolutionManager } from '@oa/evolution';
export { createGoalManager } from '@oa/goals';
export { createHookRegistry, createHook } from '@oa/hooks';

// Re-export constants
export {
  EventTypes,
  RiskLevels,
  MemoryTiers,
  HookPoints,
  MemoryTypes,
  MemoryScopes,
  PermissionModes,
  Verdicts,
  ToolExecutionModes,
  ToolScopes,
  ToolCallStatuses,
  PluginStatuses,
  SessionStatuses,
  TurnEndReasons,
  StopReasons,
  ThinkingLevels,
  ProviderTypes,
  DEFAULT_AGENT_LOOP,
  DEFAULT_TOOL,
  DEFAULT_LLM,
  DEFAULT_MEMORY,
  DEFAULT_SECURITY,
  DEFAULT_STORAGE,
  DEFAULT_PLUGIN_MANAGER,
  DEFAULT_EVENT_STORE,
  DEFAULT_MCP,
  DEFAULT_TIER_POLICIES,
  OVOLVEAGENT_VERSION,
  OVOLVEAGENT_NAME,
} from '@oa/constants';

// Re-export builtins
export {
  createRiskControlPlugin,
  createMemoryLayerPlugin,
  createCompactionPlugin,
  createSecurityPlugin,
  createShellExecTool,
  createAllFileTools,
  createAllSearchTools,
  createAskUserTool,
  createSkillLoadTool,
  registerBuiltinPlugins,
  registerBuiltinTools,
  createAllBuiltinPlugins,
  createAllBuiltinTools,
} from '@oa/builtins';

// Plugin development utilities
export { createSimplePlugin } from '@oa/plugins';

// Tool development utilities
export {
  createMinimalToolDefinition,
  createToolResult,
  createToolError,
  textToolContent,
  jsonToolContent,
} from '@oa/tools';

/**
 * SDK version — matches OvolveAgent version.
 */
export const SDK_VERSION = '0.1.0';
