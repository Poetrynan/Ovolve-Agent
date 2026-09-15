/**
 * @oa/hooks — External Hook Runner types
 *
 * Type definitions for the hook system that executes external scripts
 * at key points in the agent lifecycle.
 */

import type { HookEvent } from './events.js';

/** Hook script configuration */
export interface HookScript {
  /** Command to execute (absolute path or command name) */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory for execution */
  cwd?: string;
  /** Timeout in milliseconds (default 60000) */
  timeout?: number;
  /** Maximum output bytes (default 65536) */
  maxOutputBytes?: number;
  /** Whether this hook is enabled */
  enabled?: boolean;
}

/** Hook configuration for a specific event */
export interface HookEventConfig {
  /** Events that trigger this hook */
  events: HookEvent[];
  /** Scripts to execute */
  hooks: HookScript[];
}

/** Top-level hooks configuration */
export interface HookConfig {
  /** Map of event name to hook configuration */
  hooks: Partial<Record<HookEvent, HookScript[]>>;
  /** Global enabled/disabled state */
  enabled?: boolean;
  /** Default timeout for all hooks */
  defaultTimeout?: number;
  /** Default max output bytes */
  defaultMaxOutputBytes?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Context passed to hook scripts via stdin as JSON */
export interface HookContext {
  /** The event that triggered this hook */
  event: HookEvent;
  /** Session identifier */
  sessionId?: string;
  /** Current timestamp */
  timestamp: number;
  /** Project directory */
  projectDir: string;
  /** User home directory */
  homeDir: string;
  /** Additional event-specific data */
  data?: Record<string, unknown>;
}

/** Result from a single hook script execution */
export interface HookResult {
  /** The hook script that was executed */
  script: HookScript;
  /** Exit code from the script */
  exitCode: number;
  /** Whether the hook passed (exit code 0) */
  passed: boolean;
  /** Whether the hook blocked (exit code 2) */
  blocked: boolean;
  /** Parsed JSON output from the script */
  output?: HookOutput;
  /** Raw stdout text */
  stdout: string;
  /** Raw stderr text */
  stderr: string;
  /** Execution duration in milliseconds */
  duration: number;
  /** Error message if execution failed */
  error?: string;
}

/** Parsed hook output (JSON from stdout) */
export interface HookOutput {
  /** Whether to continue processing */
  continue?: boolean;
  /** Suppress the default behavior */
  suppress?: boolean;
  /** Block the operation (maps to exit code 2) */
  block?: boolean;
  /** Reason for blocking */
  blockReason?: string;
  /** Override the user prompt */
  overridePrompt?: string;
  /** Override the system prompt */
  overrideSystemPrompt?: string;
  /** Additional context to inject */
  additionalContext?: string;
  /** Suppress tool output */
  suppressToolOutput?: boolean;
  /** Suppress the next message */
  suppressMessage?: boolean;
  /** User-facing message */
  userMessage?: string;
  /** System message for the agent */
  systemMessage?: string;
  /** Decision reason for logging */
  decisionReason?: string;
  /** Arbitrary additional data */
  [key: string]: unknown;
}

/** Aggregated result from all hooks for an event */
export interface HookExecutionResult {
  /** The event that was triggered */
  event: HookEvent;
  /** Individual hook results */
  results: HookResult[];
  /** Whether any hook blocked */
  blocked: boolean;
  /** Block reason if blocked */
  blockReason?: string;
  /** Combined output from all hooks */
  combinedOutput: HookOutput;
  /** Total execution duration */
  duration: number;
}

/** Config file location info */
export interface ConfigLocation {
  /** Path to the config file */
  path: string;
  /** Whether the file exists */
  exists: boolean;
  /** Scope: project or user */
  scope: 'project' | 'user';
}

/** Hook runner options */
export interface HookRunnerOptions {
  /** Project directory (for template expansion) */
  projectDir?: string;
  /** User home directory */
  homeDir?: string;
  /** Default timeout in milliseconds */
  defaultTimeout?: number;
  /** Default max output bytes */
  defaultMaxOutputBytes?: number;
  /** Whether hooks are enabled by default */
  enabled?: boolean;
}

/** Audit event for hook execution */
export interface HookAuditEvent {
  timestamp: number;
  event: HookEvent;
  script: string;
  exitCode: number;
  duration: number;
  blocked: boolean;
  error?: string;
}
