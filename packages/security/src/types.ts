/**
 * @oa/security — Type definitions
 * 
 * Ovolve's 7-layer defense-in-depth security system.
 * Layers: Sanitizer → Risk Controller → Output Guard → Path Guard → Danger Classifier → Tool Hooks → Pipeline
 */

/** Risk levels for tool calls */
export enum RiskLevel {
  /** Safe operations (read-only, info queries) */
  LOW = 'LOW',
  /** Moderate risk (file reads, API calls) */
  MEDIUM = 'MEDIUM',
  /** High risk (file writes, installations) */
  HIGH = 'HIGH',
  /** Critical risk (deletions, system changes) */
  CRITICAL = 'CRITICAL',
}

/** Permission modes for tool execution */
export enum PermissionMode {
  /** Plan only — no execution */
  PLAN = 'PLAN',
  /** Read-only operations allowed */
  READ_ONLY = 'READ_ONLY',
  /** User confirmation required for each action */
  CONFIRM = 'CONFIRM',
  /** Automatic execution with constraints */
  AUTO = 'AUTO',
  /** Full automatic execution */
  FULL = 'FULL',
}

/** Security verdict for a tool call */
export enum Verdict {
  /** Operation denied */
  DENY = 'DENY',
  /** Operation requires confirmation */
  CONFIRM = 'CONFIRM',
  /** Operation allowed */
  ALLOW = 'ALLOW',
}

/** Tool call representation */
export interface ToolCall {
  /** Tool identifier */
  id: string;
  /** Tool name */
  name: string;
  /** Tool arguments */
  arguments: Record<string, unknown>;
  /** Optional command string (for shell tools) */
  command?: string;
  /** Session context */
  sessionId: string;
}

/** Security check result */
export interface SecurityResult {
  /** The verdict */
  verdict: Verdict;
  /** Risk level assessed */
  riskLevel: RiskLevel;
  /** Human-readable reason */
  reason: string;
  /** Layer that produced the verdict */
  source: string;
  /** Whether this verdict is final (cannot be overridden) */
  final: boolean;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Full pipeline result */
export interface PipelineResult {
  /** Whether the tool call is permitted */
  allowed: boolean;
  /** Final verdict after all layers */
  verdict: Verdict;
  /** Final risk level */
  riskLevel: RiskLevel;
  /** Results from each layer */
  layerResults: LayerResult[];
  /** Sanitized arguments (if modified) */
  sanitizedArguments?: Record<string, unknown>;
  /** User-facing message */
  message: string;
  /** Time taken in milliseconds */
  elapsedMs: number;
}

/** Individual layer result */
export interface LayerResult {
  /** Layer name */
  name: string;
  /** Layer priority */
  priority: number;
  /** Verdict from this layer */
  verdict: Verdict;
  /** Risk level from this layer */
  riskLevel: RiskLevel;
  /** Reason for verdict */
  reason: string;
  /** Whether this layer blocked execution */
  blocked: boolean;
  /** Processing time in ms */
  elapsedMs: number;
}

/** Security layer interface */
export interface SecurityLayer {
  /** Layer name */
  name: string;
  /** Execution priority (lower = runs first) */
  priority: number;
  /** Check a tool call */
  check(toolCall: ToolCall, context: SecurityContext): Promise<LayerResult>;
}

/** Security context passed through the pipeline */
export interface SecurityContext {
  /** Current permission mode */
  permissionMode: PermissionMode;
  /** Workspace root directory */
  workspaceRoot: string;
  /** User home directory */
  userHome: string;
  /** Whether user is root/admin */
  isRoot: boolean;
  /** Session ID */
  sessionId: string;
  /** Accumulated results from previous layers */
  previousResults: LayerResult[];
  /** Persistent permission rules */
  permissionRules: PermissionRule[];
}

/** Persistent permission rule */
export interface PermissionRule {
  /** Rule ID */
  id: string;
  /** Tool name pattern (regex) */
  toolPattern: string;
  /** Command pattern (regex, for shell tools) */
  commandPattern?: string;
  /** Verdict to apply */
  verdict: Verdict;
  /** Risk level to assign */
  riskLevel: RiskLevel;
  /** Rule expiration (0 = never) */
  expiresAt: number;
  /** Creation timestamp */
  createdAt: number;
}

/** Path guard configuration */
export interface PathGuardConfig {
  /** Additional blacklisted paths */
  extraBlacklistedPaths?: string[];
  /** Additional protected files */
  extraProtectedFiles?: string[];
  /** Whether to allow writes outside workspace */
  allowOutsideWorkspace?: boolean;
}

/** Danger classifier configuration */
export interface DangerClassifierConfig {
  /** Whether root escalation is allowed */
  allowRootEscalation?: boolean;
  /** Custom rules per interpreter */
  customRules?: Partial<Record<InterpreterType, ClassifierRule[]>>;
  /** Denial cache TTL in ms */
  denialCacheTtlMs?: number;
}

/** Interpreter types for danger classification */
export enum InterpreterType {
  POSIX = 'POSIX',
  POWERSHELL = 'POWERSHELL',
  CMD = 'CMD',
  PYTHON = 'PYTHON',
  JAVASCRIPT = 'JAVASCRIPT',
  SQL = 'SQL',
}

/** Classifier rule for an interpreter */
export interface ClassifierRule {
  /** Pattern to match (regex) */
  pattern: string;
  /** Verdict if matched */
  verdict: Verdict;
  /** Risk level if matched */
  riskLevel: RiskLevel;
  /** Human-readable description */
  description: string;
  /** Whether this rule applies to wrapped commands */
  appliesToWrapped?: boolean;
}

/** Risk controller configuration */
export interface RiskControllerConfig {
  /** Default permission mode */
  defaultPermissionMode?: PermissionMode;
  /** Risk-to-mode mapping */
  riskModeMapping?: Partial<Record<RiskLevel, PermissionMode>>;
  /** Path to rules database */
  rulesDbPath?: string;
}

/** Output guard configuration */
export interface OutputGuardConfig {
  /** Additional extraction patterns */
  extraPatterns?: RegExp[];
  /** Whether to normalize zero-width chars */
  normalizeZeroWidth?: boolean;
}

/** Sanitizer configuration */
export interface SanitizerConfig {
  /** Additional patterns to redact */
  extraPatterns?: Array<{ pattern: RegExp; replacement: string }>;
  /** Whether to redact MAC addresses */
  redactMac?: boolean;
  /** Whether to redact workspace paths */
  redactWorkspace?: boolean;
  /** Whether to redact user home paths */
  redactHome?: boolean;
}

/** Tool hooks configuration */
export interface ToolHooksConfig {
  /** Whether to check for prompt injection */
  checkInjection?: boolean;
  /** Whether to redact secrets in output */
  redactSecrets?: boolean;
  /** Additional credential patterns */
  extraSecretPatterns?: RegExp[];
}

/** Full security pipeline configuration */
export interface SecurityPipelineConfig {
  /** Default permission mode */
  permissionMode?: PermissionMode;
  /** Workspace root */
  workspaceRoot?: string;
  /** User home directory */
  userHome?: string;
  /** Whether running as root */
  isRoot?: boolean;
  /** Path guard config */
  pathGuard?: PathGuardConfig;
  /** Danger classifier config */
  dangerClassifier?: DangerClassifierConfig;
  /** Risk controller config */
  riskController?: RiskControllerConfig;
  /** Output guard config */
  outputGuard?: OutputGuardConfig;
  /** Sanitizer config */
  sanitizer?: SanitizerConfig;
  /** Tool hooks config */
  toolHooks?: ToolHooksConfig;
}

/** Hook event types */
export enum HookEvent {
  PRE_TOOL_USE = 'pre_tool_use',
  POST_TOOL_USE = 'post_tool_use',
  TOOL_ABORT = 'tool_abort',
}

/** Hook handler function */
export type HookHandler = (toolCall: ToolCall, context: SecurityContext) => Promise<HookResult>;

/** Hook result */
export interface HookResult {
  /** Whether to proceed */
  proceed: boolean;
  /** Modified tool call (if any) */
  modifiedToolCall?: ToolCall;
  /** Additional message */
  message?: string;
}
