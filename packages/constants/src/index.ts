/**
 * @oa/constants — Shared Constants for OvolveAgent
 *
 * Centralized constants used across all packages.
 * Includes event types, risk levels, memory tiers, hook points, and default values.
 */

// ===========================================================================
// Event Types (mirrors @oa/event-store EventType)
// ===========================================================================

export const EventTypes = {
  // Session lifecycle
  SessionCreated: 'session.created',
  SessionUpdated: 'session.updated',
  SessionDeleted: 'session.deleted',
  SessionArchived: 'session.archived',
  SessionRestored: 'session.restored',

  // Message lifecycle
  MessageCreated: 'message.created',
  MessageUpdated: 'message.updated',
  MessageDeleted: 'message.deleted',
  MessageReactionAdded: 'message.reaction.added',
  MessageReactionRemoved: 'message.reaction.removed',

  // Task lifecycle
  TaskCreated: 'task.created',
  TaskUpdated: 'task.updated',
  TaskCompleted: 'task.completed',
  TaskFailed: 'task.failed',
  TaskCancelled: 'task.cancelled',

  // Tool execution
  ToolCallRequested: 'tool.call.requested',
  ToolCallStarted: 'tool.call.started',
  ToolCallCompleted: 'tool.call.completed',
  ToolCallFailed: 'tool.call.failed',
  ToolCallCancelled: 'tool.call.cancelled',

  // File operations
  FileRead: 'file.read',
  FileWritten: 'file.written',
  FileDeleted: 'file.deleted',
  FileSnapshotCreated: 'file.snapshot.created',
  FileSnapshotRestored: 'file.snapshot.restored',

  // Memory & context
  MemoryEntryAdded: 'memory.entry.added',
  MemoryEntryUpdated: 'memory.entry.updated',
  MemoryEntryDeleted: 'memory.entry.deleted',
  ContextWindowAdjusted: 'context.window.adjusted',

  // Agent state
  AgentStateChanged: 'agent.state.changed',
  AgentErrorOccurred: 'agent.error.occurred',
  CheckpointCreated: 'checkpoint.created',
  CheckpointRestored: 'checkpoint.restored',
} as const;

export type EventTypeString = typeof EventTypes[keyof typeof EventTypes];

/** Total number of event types — MUST stay at 33 */
export const EVENT_TYPE_COUNT = 33;

// ===========================================================================
// Risk Levels (mirrors @oa/plugins RiskLevel)
// ===========================================================================

export const RiskLevels = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;

export type RiskLevelString = typeof RiskLevels[keyof typeof RiskLevels];

/** Risk ordering for comparison */
export const RISK_ORDER: Record<RiskLevelString, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

// ===========================================================================
// Memory Tiers (mirrors @oa/memory MemoryTier)
// ===========================================================================

export const MemoryTiers = {
  WORKING: 'WORKING',
  SHORT_TERM_RECALL: 'SHORT_TERM_RECALL',
  LONG_TERM: 'LONG_TERM',
  SEMANTIC: 'SEMANTIC',
  WIKI: 'WIKI',
  DREAMING: 'DREAMING',
} as const;

export type MemoryTierString = typeof MemoryTiers[keyof typeof MemoryTiers];

/** Total number of memory tiers — MUST stay at 6 */
export const MEMORY_TIER_COUNT = 6;

/** Tier ordering in the hierarchy (bottom to top) */
export const TIER_HIERARCHY: MemoryTierString[] = [
  MemoryTiers.WORKING,
  MemoryTiers.SHORT_TERM_RECALL,
  MemoryTiers.LONG_TERM,
  MemoryTiers.SEMANTIC,
  MemoryTiers.WIKI,
  MemoryTiers.DREAMING,
];

// ===========================================================================
// Hook Points (mirrors @oa/plugins HookPoint)
// ===========================================================================

export const HookPoints = {
  PRE_TOOL_USE: 'PRE_TOOL_USE',
  POST_TOOL_USE: 'POST_TOOL_USE',
  PRE_LLM_REQUEST: 'PRE_LLM_REQUEST',
  POST_LLM_RESPONSE: 'POST_LLM_RESPONSE',
  PRE_FOLD: 'PRE_FOLD',
  POST_FOLD: 'POST_FOLD',
  SESSION_START: 'SESSION_START',
  SESSION_END: 'SESSION_END',
  SUBAGENT_STOP: 'SUBAGENT_STOP',
} as const;

export type HookPointString = typeof HookPoints[keyof typeof HookPoints];

/** Total number of hook points — MUST stay at 9 */
export const HOOK_POINT_COUNT = 9;

// ===========================================================================
// Memory Types (mirrors @oa/memory MemoryType)
// ===========================================================================

export const MemoryTypes = {
  CONVERSATION: 'CONVERSATION',
  PREFERENCE: 'PREFERENCE',
  FACT: 'FACT',
  PROJECT: 'PROJECT',
  IDENTITY: 'IDENTITY',
  TASK: 'TASK',
  PATTERN: 'PATTERN',
  LINK: 'LINK',
} as const;

export type MemoryTypeString = typeof MemoryTypes[keyof typeof MemoryTypes];

// ===========================================================================
// Memory Scopes (mirrors @oa/memory MemoryScope)
// ===========================================================================

export const MemoryScopes = {
  GLOBAL: 'GLOBAL',
  SESSION: 'SESSION',
  USER: 'USER',
  PROJECT: 'PROJECT',
} as const;

export type MemoryScopeString = typeof MemoryScopes[keyof typeof MemoryScopes];

// ===========================================================================
// Permission Modes (mirrors @oa/security PermissionMode)
// ===========================================================================

export const PermissionModes = {
  PLAN: 'PLAN',
  READ_ONLY: 'READ_ONLY',
  CONFIRM: 'CONFIRM',
  AUTO: 'AUTO',
  FULL: 'FULL',
} as const;

export type PermissionModeString = typeof PermissionModes[keyof typeof PermissionModes];

// ===========================================================================
// Verdicts (mirrors @oa/security Verdict)
// ===========================================================================

export const Verdicts = {
  DENY: 'DENY',
  CONFIRM: 'CONFIRM',
  ALLOW: 'ALLOW',
} as const;

export type VerdictString = typeof Verdicts[keyof typeof Verdicts];

// ===========================================================================
// Tool Execution Modes (mirrors @oa/tools ToolExecutionMode)
// ===========================================================================

export const ToolExecutionModes = {
  PARALLEL: 'PARALLEL',
  SEQUENTIAL: 'SEQUENTIAL',
  EXCLUSIVE: 'EXCLUSIVE',
} as const;

export type ToolExecutionModeString = typeof ToolExecutionModes[keyof typeof ToolExecutionModes];

// ===========================================================================
// Tool Scopes (mirrors @oa/tools ToolScope)
// ===========================================================================

export const ToolScopes = {
  GLOBAL: 'GLOBAL',
  AGENT: 'AGENT',
  SESSION: 'SESSION',
} as const;

export type ToolScopeString = typeof ToolScopes[keyof typeof ToolScopes];

// ===========================================================================
// Tool Call Statuses (mirrors @oa/tools ToolCallStatus)
// ===========================================================================

export const ToolCallStatuses = {
  PENDING: 'PENDING',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  BLOCKED: 'BLOCKED',
} as const;

export type ToolCallStatusString = typeof ToolCallStatuses[keyof typeof ToolCallStatuses];

// ===========================================================================
// Plugin Statuses (mirrors @oa/plugins PluginStatus)
// ===========================================================================

export const PluginStatuses = {
  REGISTERED: 'REGISTERED',
  LOADING: 'LOADING',
  ACTIVE: 'ACTIVE',
  UNLOADING: 'UNLOADING',
  ERROR: 'ERROR',
} as const;

export type PluginStatusString = typeof PluginStatuses[keyof typeof PluginStatuses];

// ===========================================================================
// Session Statuses (mirrors @oa/agent-loop SessionStatus)
// ===========================================================================

export const SessionStatuses = {
  idle: 'idle',
  running: 'running',
  paused: 'paused',
  waiting_for_tool: 'waiting_for_tool',
  stopped: 'stopped',
  completed: 'completed',
  error: 'error',
} as const;

export type SessionStatusString = typeof SessionStatuses[keyof typeof SessionStatuses];

// ===========================================================================
// Turn End Reasons (mirrors @oa/agent-loop TurnEndReason)
// ===========================================================================

export const TurnEndReasons = {
  natural_stop: 'natural_stop',
  max_steps_reached: 'max_steps_reached',
  timeout: 'timeout',
  stopped: 'stopped',
  error: 'error',
  follow_up: 'follow_up',
} as const;

export type TurnEndReasonString = typeof TurnEndReasons[keyof typeof TurnEndReasons];

// ===========================================================================
// Stop Reasons (mirrors @oa/llm StopReason)
// ===========================================================================

export const StopReasons = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  error: 'error',
  content_filter: 'content_filter',
} as const;

export type StopReasonString = typeof StopReasons[keyof typeof StopReasons];

// ===========================================================================
// Thinking Levels (mirrors @oa/llm ThinkingLevel)
// ===========================================================================

export const ThinkingLevels = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const;

export type ThinkingLevelString = typeof ThinkingLevels[keyof typeof ThinkingLevels];

/** All thinking levels in order */
export const THINKING_LEVELS_ORDERED: ThinkingLevelString[] = [
  ThinkingLevels.minimal,
  ThinkingLevels.low,
  ThinkingLevels.medium,
  ThinkingLevels.high,
  ThinkingLevels.xhigh,
  ThinkingLevels.max,
];

// ===========================================================================
// Provider Types (mirrors @oa/llm ProviderType)
// ===========================================================================

export const ProviderTypes = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  deepseek: 'deepseek',
  bedrock: 'bedrock',
  azure: 'azure',
  custom: 'custom',
} as const;

export type ProviderTypeString = typeof ProviderTypes[keyof typeof ProviderTypes];

// ===========================================================================
// Interpreter Types (mirrors @oa/security InterpreterType)
// ===========================================================================

export const InterpreterTypes = {
  POSIX: 'POSIX',
  POWERSHELL: 'POWERSHELL',
  CMD: 'CMD',
  PYTHON: 'PYTHON',
  JAVASCRIPT: 'JAVASCRIPT',
  SQL: 'SQL',
} as const;

export type InterpreterTypeString = typeof InterpreterTypes[keyof typeof InterpreterTypes];

// ===========================================================================
// Default Values
// ===========================================================================

/** Default agent loop configuration values */
export const DEFAULT_AGENT_LOOP = {
  maxSteps: 25,
  maxToolCallsPerStep: 50,
  toolExecutionMode: 'parallel' as const,
  maxParallelTools: 8,
  turnTimeout: 600_000, // 10 minutes
  enableMemoryInjection: true,
  enableSkillInjection: true,
};

/** Default tool configuration values */
export const DEFAULT_TOOL = {
  timeoutMs: 30000,
  maxConcurrency: 8,
  maxRetries: 3,
  retryable: true,
  requiresConfirmation: false,
};

/** Default LLM configuration values */
export const DEFAULT_LLM = {
  temperature: 0.7,
  maxTokens: 4096,
  timeout: 120_000,
  maxRetries: 5,
};

/** Default memory configuration values */
export const DEFAULT_MEMORY = {
  embeddingModel: 'BAAI/bge-base-zh-v1.5',
  embeddingDimensions: 768,
  embeddingCacheSize: 4096,
  extractionDebounceMs: 60000,
  defaultRecallLimit: 10,
  overFetchMultiplier: 4,
  mmrLambda: 0.7,
  driftThresholdDays: 90,
  decayHalfLifeDays: 30,
};

/** Default security configuration values */
export const DEFAULT_SECURITY = {
  permissionMode: 'CONFIRM' as const,
  allowRootEscalation: false,
  checkInjection: true,
  redactSecrets: true,
};

/** Default storage configuration values */
export const DEFAULT_STORAGE = {
  busyTimeout: 5000,
  walMode: true,
  foreignKeys: true,
  autoMigrate: true,
};

/** Default plugin manager configuration values */
export const DEFAULT_PLUGIN_MANAGER = {
  resolveDependencies: true,
  allowDuplicateNames: false,
};

/** Default event store configuration values */
export const DEFAULT_EVENT_STORE = {
  autoSnapshot: true,
  snapshotInterval: 100,
};

/** Default MCP configuration values */
export const DEFAULT_MCP = {
  defaultTimeout: 30000,
  defaultHeartbeatInterval: 30000,
  defaultHeartbeatTimeout: 10000,
  enabled: true,
};

// ===========================================================================
// Tier Policies (default policies for each memory tier)
// ===========================================================================

export const DEFAULT_TIER_POLICIES = {
  WORKING: {
    persistence: 'NONE' as const,
    tokenBudget: 600,
    trust: 0.0,
    recallMode: 'ALWAYS' as const,
    promotionThreshold: 0,
    decayEnabled: false,
    decayHalfLifeDays: 0,
  },
  SHORT_TERM_RECALL: {
    persistence: 'TTL' as const,
    ttlMs: 43_200_000, // 12 hours
    tokenBudget: 1000,
    trust: 0.85,
    recallMode: 'ON_DEMAND' as const,
    promotionThreshold: 3,
    decayEnabled: true,
    decayHalfLifeDays: 1,
  },
  LONG_TERM: {
    persistence: 'PERMANENT' as const,
    tokenBudget: 2500,
    trust: 1.0,
    recallMode: 'ON_DEMAND' as const,
    promotionThreshold: 5,
    decayEnabled: true,
    decayHalfLifeDays: 30,
  },
  SEMANTIC: {
    persistence: 'PERMANENT' as const,
    tokenBudget: 1500,
    trust: 0.8,
    recallMode: 'ON_DEMAND' as const,
    promotionThreshold: 0,
    decayEnabled: false,
    decayHalfLifeDays: 0,
  },
  WIKI: {
    persistence: 'PERMANENT' as const,
    tokenBudget: 2000,
    trust: 0.9,
    recallMode: 'ON_DEMAND' as const,
    promotionThreshold: 0,
    decayEnabled: false,
    decayHalfLifeDays: 0,
  },
  DREAMING: {
    persistence: 'TTL' as const,
    ttlMs: 2_592_000_000, // 30 days
    tokenBudget: 800,
    trust: 0.55,
    recallMode: 'ON_DEMAND' as const,
    promotionThreshold: 0,
    decayEnabled: true,
    decayHalfLifeDays: 30,
  },
} as const;

// ===========================================================================
// Version & Metadata
// ===========================================================================

/** OvolveAgent version */
export const OVOLVEAGENT_VERSION = '0.1.0';

/** OvolveAgent product name */
export const OVOLVEAGENT_NAME = 'OvolveAgent';

/** OvolveAgent description */
export const OVOLVEAGENT_DESCRIPTION = 'A production-grade, event-sourced, locally-deployable AI Agent Runtime';

/** OvolveAgent license */
export const OVOLVEAGENT_LICENSE = 'MIT';

/** OvolveAgent repository URL */
export const OVOLVEAGENT_REPOSITORY = 'https://github.com/ovolveagent/ovolveagent';

// ===========================================================================
// File Paths & Patterns
// ===========================================================================

/** Default database file name */
export const DEFAULT_DB_NAME = 'ovolveagent.db';

/** Default config file name */
export const DEFAULT_CONFIG_NAME = 'ovolveagent.config.ts';

/** Default data directory */
export const DEFAULT_DATA_DIR = '.ovolveagent';

/** Log file patterns */
export const LOG_PATTERNS = {
  agent: 'agent-*.log',
  error: 'error-*.log',
  audit: 'audit-*.log',
} as const;

// ===========================================================================
// Limits & Thresholds
// ===========================================================================

/** Maximum message length in characters */
export const MAX_MESSAGE_LENGTH = 100_000;

/** Maximum file size for reading in bytes (10MB) */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Maximum embedding dimensions */
export const MAX_EMBEDDING_DIMENSIONS = 1536;

/** Maximum context window in tokens */
export const MAX_CONTEXT_WINDOW = 128_000;

/** Maximum number of sessions to list */
export const MAX_SESSION_LIST = 100;

/** Maximum number of search results */
export const MAX_SEARCH_RESULTS = 50;

/** Maximum number of memory entries to recall */
export const MAX_MEMORY_RECALL = 20;

/** Maximum tool call depth */
export const MAX_TOOL_DEPTH = 10;

/** Maximum retry attempts for operations */
export const MAX_RETRY_ATTEMPTS = 5;

/** Default retry delay in ms */
export const DEFAULT_RETRY_DELAY = 1000;

/** Maximum retry delay in ms */
export const MAX_RETRY_DELAY = 30_000;
