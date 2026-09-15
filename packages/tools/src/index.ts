/**
 * @oa/tools — Tool Registry for OvolveAgent
 *
 * Tool registry patterns for OvolveAgent.
 * Provides tool registration, validation, scoped dispatch, and execution pipeline.
 */

// ─── Core Types ───────────────────────────────────────────────────────────
export {
  ToolExecutionMode,
  ToolScope,
  ToolCallStatus,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
  type ToolCall,
  type ToolContent,
  type ToolError,
  type ToolResultMetadata,
  type ToolRegistryConfig,
  type ToolListFilter,
  type HistoryEntry,
  type DispatchOptions,
  type DispatchResult,
  type ToolServices,
  type AskUserQuestion,
  type AskUserOptions,
  type SubAgentConfig,
  type ValidationResult,
  type ToolGuard,
  type ToolHook,
  type InputSchema,
  type JSONSchemaProperty,
} from './types';

// ─── Tool Definition Builder ──────────────────────────────────────────────
export {
  ToolDefinitionBuilder,
  validateToolDefinition,
  createSuccessResult,
  createErrorResult,
  textContent,
  jsonContent,
  generateCallId,
} from './tool-definition';

// ─── Execution Pipeline ───────────────────────────────────────────────────
export {
  ExecutionPipeline,
  PipelineError,
} from './execution-pipeline';

// ─── Tool Registry ────────────────────────────────────────────────────────
export {
  ToolRegistry,
  createToolRegistry,
} from './tool-registry';

// ─── Built-in Tools ───────────────────────────────────────────────────────
export {
  createAskUserTool,
  type AskUserArgs,
} from './built-in/ask-user';

export {
  createSkillLoadTool,
  createSkillUnloadTool,
  createSkillListTool,
  type SkillLoadArgs,
  type SkillInfo,
} from './built-in/skill-load';

export {
  createShellExecTool,
  createRestrictedShellExecTool,
  type ShellExecArgs,
  type ShellExecOutput,
} from './built-in/shell-executor';

export {
  createFileReadTool,
  createFileWriteTool,
  createFileEditTool,
  createFileDeleteTool,
  createFileListTool,
  createAllFileTools,
  type FileReadArgs,
  type FileWriteArgs,
  type FileEditArgs,
  type FileDeleteArgs,
  type FileListArgs,
} from './built-in/file-tools';

export {
  createGrepTool,
  createFindTool,
  createSearchTool,
  createGlobTool,
  createAllSearchTools,
  type GrepArgs,
  type GrepMatch,
  type FindArgs,
  type FindResult,
  type SearchArgs,
  type SearchResult,
  type GlobArgs,
} from './built-in/search-tools';
