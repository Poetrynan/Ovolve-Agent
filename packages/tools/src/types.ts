/**
 * @oa/tools — Core types
 *
 * Tool registry types for OvolveAgent.
 * Provides typed tool definitions, execution contexts, and result types.
 */

import { RiskLevel } from '@oa/plugins';
import type { PluginContext } from '@oa/plugins';

export { RiskLevel };
export type { PluginContext };

/**
 * JSON Schema property definition for tool parameters.
 */
export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/**
 * JSON Schema for tool input parameters.
 */
export interface InputSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Tool execution mode — determines how the tool can run relative to others.
 */
export enum ToolExecutionMode {
  /** Tool can run concurrently with other tools. */
  PARALLEL = 'PARALLEL',
  /** Tool must run sequentially with respect to other sequential tools. */
  SEQUENTIAL = 'SEQUENTIAL',
  /** Tool must run exclusively — no other tool can run simultaneously. */
  EXCLUSIVE = 'EXCLUSIVE',
}

/**
 * Scope of tool registration.
 */
export enum ToolScope {
  /** Available to all agents globally. */
  GLOBAL = 'GLOBAL',
  /** Available only to a specific agent. */
  AGENT = 'AGENT',
  /** Available only within a specific session. */
  SESSION = 'SESSION',
}

/**
 * The core tool definition. Every tool registered in the system
 * must conform to this interface.
 */
export interface ToolDefinition {
  /** Unique tool name. */
  name: string;
  /** Human-readable description for the LLM. */
  description: string;
  /** JSON Schema for input parameters. */
  inputSchema: InputSchema;
  /** Execution mode for concurrency control. */
  executionMode: ToolExecutionMode;
  /** Risk level of this tool. */
  riskLevel: RiskLevel;
  /** Scope of availability. */
  scope: ToolScope;
  /** Agent ID if scope is AGENT. */
  agentId?: string;
  /** Session ID if scope is SESSION. */
  sessionId?: string;
  /** Whether this tool requires explicit user confirmation. */
  requiresConfirmation: boolean;
  /** Timeout in milliseconds. Default 30000. */
  timeoutMs: number;
  /** Whether this tool can be retried on failure. */
  retryable: boolean;
  /** Maximum retry attempts if retryable. */
  maxRetries: number;
  /** Metadata for extensions. */
  metadata?: Record<string, unknown>;
  /**
   * The actual execution function.
   * Receives parsed arguments and execution context.
   * Returns the tool result.
   */
  execute: (args: unknown, context: ToolExecutionContext) => Promise<ToolResult>;
}

/**
 * Context provided to a tool during execution.
 */
export interface ToolExecutionContext {
  /** Plugin context with session/agent info. */
  pluginContext: PluginContext;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Execution depth (for sub-agent tracking). */
  depth: number;
  /** Parent tool call ID if called from another tool. */
  parentCallId?: string;
  /** Available services/injections. */
  services: ToolServices;
}

/**
 * Services available to tools during execution.
 */
export interface ToolServices {
  /** Ask the user a question. */
  askUser: (question: string, options?: AskUserOptions) => Promise<string>;
  /** Spawn a sub-agent. */
  spawnSubAgent: (config: SubAgentConfig) => Promise<string>;
  /** Get the current event store. */
  getEventStore?: () => unknown;
}

/**
 * Options for asking the user a question.
 */
export interface AskUserQuestion {
  /** The question to ask. */
  question: string;
  /** Optional default value. */
  defaultValue?: string;
  /** Optional choices for multiple choice. */
  choices?: string[];
  /** Whether the response is required. */
  required?: boolean;
}

/**
 * Alias for AskUserQuestion for backward compatibility.
 */
export type AskUserOptions = AskUserQuestion;

/**
 * Configuration for spawning a sub-agent.
 */
export interface SubAgentConfig {
  /** Task description for the sub-agent. */
  task: string;
  /** Tools available to the sub-agent. */
  allowedTools?: string[];
  /** Maximum execution depth. */
  maxDepth?: number;
  /** Whether to run asynchronously. */
  async?: boolean;
}

/**
 * A tool call record — represents an invocation of a tool.
 */
export interface ToolCall {
  /** Unique call identifier. */
  id: string;
  /** Name of the tool being called. */
  name: string;
  /** Parsed arguments. */
  args: Record<string, unknown>;
  /** Timestamp of the call. */
  timestamp: Date;
  /** Current status of the call. */
  status: ToolCallStatus;
  /** Execution context snapshot. */
  context?: Partial<ToolExecutionContext>;
}

/**
 * Status of a tool call.
 */
export enum ToolCallStatus {
  PENDING = 'PENDING',
  EXECUTING = 'EXECUTING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  BLOCKED = 'BLOCKED',
}

/**
 * Result of a tool execution.
 */
export interface ToolResult {
  /** Whether the execution succeeded. */
  success: boolean;
  /** The output content. Can be string or structured data. */
  content: ToolContent[];
  /** Error information if failed. */
  error?: ToolError;
  /** Execution metadata. */
  metadata: ToolResultMetadata;
}

/**
 * Content types that can appear in a tool result.
 */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'json'; data: unknown }
  | { type: 'error'; message: string; code?: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Error information for failed tool executions.
 */
export interface ToolError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** Whether this error is retryable. */
  retryable: boolean;
}

/**
 * Metadata about the tool execution.
 */
export interface ToolResultMetadata {
  /** Tool name that produced this result. */
  toolName: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Token count of the result (for context tracking). */
  tokenCount?: number;
  /** Number of retries attempted. */
  retryCount: number;
  /** Whether the result was truncated. */
  truncated: boolean;
  /** Additional metadata. */
  extra?: Record<string, unknown>;
}

/**
 * Configuration for the ToolRegistry factory.
 */
export interface ToolRegistryConfig {
  /** Maximum concurrent tool executions. */
  maxConcurrency: number;
  /** Default timeout for tool execution in ms. */
  defaultTimeoutMs: number;
  /** Whether to record tool call history. */
  recordHistory: boolean;
  /** Maximum history entries to retain. */
  maxHistoryEntries: number;
  /** Plugin manager integration for hook dispatch. */
  pluginManager?: import('@oa/plugins').PluginManager;
  /** Services available to tools. */
  services?: Partial<ToolServices>;
}

/**
 * Options for tool dispatch.
 */
export interface DispatchOptions {
  /** Override timeout for this dispatch. */
  timeoutMs?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Execution depth (for sub-agent tracking). */
  depth?: number;
  /** Parent tool call ID. */
  parentCallId?: string;
  /** Whether to skip hook execution. */
  skipHooks?: boolean;
  /** Additional context overrides. */
  contextOverrides?: Partial<ToolExecutionContext>;
}

/**
 * Result of a dispatch operation.
 */
export interface DispatchResult {
  call: ToolCall;
  result: ToolResult;
}

/**
 * Entry in the tool call history.
 */
export interface HistoryEntry {
  call: ToolCall;
  result: ToolResult;
  completedAt: Date;
}

/**
 * Filter for listing tools.
 */
export interface ToolListFilter {
  scope?: ToolScope;
  agentId?: string;
  sessionId?: string;
  riskLevel?: RiskLevel;
  executionMode?: ToolExecutionMode;
  namePattern?: RegExp;
}

/**
 * Validation result for tool definitions.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Guard function that can prevent tool execution.
 */
export type ToolGuard = (
  definition: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<boolean> | boolean;

/**
 * Hook function for the execution pipeline.
 */
export type ToolHook = (
  definition: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<Record<string, unknown>> | Record<string, unknown>;
