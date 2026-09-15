/**
 * @oa/builtins — Built-in Plugins and Tools for OvolveAgent
 *
 * Re-exports all built-in plugins and tools for convenient registration.
 * This package serves as the single entry point for OvolveAgent's default
 * capabilities.
 *
 * @example
 * ```ts
 * import {
 *   createRiskControlPlugin,
 *   createMemoryLayerPlugin,
 *   createCompactionPlugin,
 *   createSecurityPlugin,
 *   createShellExecTool,
 *   createAllFileTools,
 *   createAllSearchTools,
 *   createAskUserTool,
 *   createSkillLoadTool,
 * } from '@oa/builtins';
 * ```
 */

// ─── Built-in Plugins ──────────────────────────────────────────────────────

export {
  RiskControlPlugin,
  createRiskControlPlugin,
  type RiskControlConfig,
  type AuditEntry,
  type ToolUsePayload as RiskToolUsePayload,
} from '@oa/plugins';

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
} from '@oa/plugins';

export {
  CompactionPlugin,
  CompactionStrategy,
  createCompactionPlugin,
  type CompactionConfig,
  type CompactionMessage,
  type CompactionResult,
  type PreFoldPayload,
  type PostFoldPayload,
} from '@oa/plugins';

export {
  SecurityPlugin,
  createSecurityPlugin,
  type SecurityConfig,
  type SecurityRule,
  type SecurityEvent,
  type ToolUsePayload as SecurityToolUsePayload,
} from '@oa/plugins';

// ─── Built-in Tools ────────────────────────────────────────────────────────

export {
  createAskUserTool,
  type AskUserArgs,
} from '@oa/tools';

export {
  createSkillLoadTool,
  createSkillUnloadTool,
  createSkillListTool,
  type SkillLoadArgs,
  type SkillInfo,
} from '@oa/tools';

export {
  createShellExecTool,
  createRestrictedShellExecTool,
  type ShellExecArgs,
  type ShellExecOutput,
} from '@oa/tools';

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
} from '@oa/tools';

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
} from '@oa/tools';

// ─── Convenience Registration ──────────────────────────────────────────────

import { createRiskControlPlugin } from '@oa/plugins';
import { createMemoryLayerPlugin } from '@oa/plugins';
import { createCompactionPlugin } from '@oa/plugins';
import { createSecurityPlugin } from '@oa/plugins';
import { createShellExecTool } from '@oa/tools';
import { createAllFileTools } from '@oa/tools';
import { createAllSearchTools } from '@oa/tools';
import { createAskUserTool } from '@oa/tools';
import { createSkillLoadTool } from '@oa/tools';
import type { PluginManager } from '@oa/plugins';
import type { ToolRegistry } from '@oa/tools';

/**
 * Options for registering all built-in plugins.
 */
export interface RegisterBuiltinPluginsOptions {
  /** Enable risk control plugin (default: true) */
  riskControl?: boolean;
  /** Enable memory layer plugin (default: true) */
  memoryLayer?: boolean;
  /** Enable compaction plugin (default: true) */
  compaction?: boolean;
  /** Enable security plugin (default: true) */
  security?: boolean;
  /** Custom risk control config */
  riskControlConfig?: Parameters<typeof createRiskControlPlugin>[0];
  /** Custom memory layer config */
  memoryLayerConfig?: Parameters<typeof createMemoryLayerPlugin>[0];
  /** Custom compaction config */
  compactionConfig?: Parameters<typeof createCompactionPlugin>[0];
  /** Custom security config */
  securityConfig?: Parameters<typeof createSecurityPlugin>[0];
}

/**
 * Register all built-in plugins with the plugin manager.
 */
export async function registerBuiltinPlugins(
  pluginManager: PluginManager,
  options: RegisterBuiltinPluginsOptions = {}
): Promise<void> {
  const {
    riskControl = true,
    memoryLayer = true,
    compaction = true,
    security = true,
    riskControlConfig,
    memoryLayerConfig,
    compactionConfig,
    securityConfig,
  } = options;

  if (riskControl) {
    await pluginManager.load(createRiskControlPlugin(riskControlConfig));
  }
  if (memoryLayer) {
    await pluginManager.load(createMemoryLayerPlugin(memoryLayerConfig));
  }
  if (compaction) {
    await pluginManager.load(createCompactionPlugin(compactionConfig));
  }
  if (security) {
    await pluginManager.load(createSecurityPlugin(securityConfig));
  }
}

/**
 * Options for registering all built-in tools.
 */
export interface RegisterBuiltinToolsOptions {
  /** Enable shell executor (default: true) */
  shell?: boolean;
  /** Enable file tools (default: true) */
  fileTools?: boolean;
  /** Enable search tools (default: true) */
  searchTools?: boolean;
  /** Enable ask user tool (default: true) */
  askUser?: boolean;
  /** Enable skill load tool (default: true) */
  skillLoad?: boolean;
  /** Restricted shell mode (default: false) */
  restrictedShell?: boolean;
}

/**
 * Register all built-in tools with the tool registry.
 */
export function registerBuiltinTools(
  toolRegistry: ToolRegistry,
  options: RegisterBuiltinToolsOptions = {}
): void {
  const {
    shell = true,
    fileTools = true,
    searchTools = true,
    askUser = true,
    skillLoad = true,
    restrictedShell = false,
  } = options;

  if (shell) {
    const tool = restrictedShell
      ? createRestrictedShellExecTool()
      : createShellExecTool();
    toolRegistry.register(tool);
  }

  if (fileTools) {
    for (const tool of createAllFileTools()) {
      toolRegistry.register(tool);
    }
  }

  if (searchTools) {
    for (const tool of createAllSearchTools()) {
      toolRegistry.register(tool);
    }
  }

  if (askUser) {
    toolRegistry.register(createAskUserTool());
  }

  if (skillLoad) {
    toolRegistry.register(createSkillLoadTool());
  }
}

/**
 * Create all built-in plugins as an array.
 */
export function createAllBuiltinPlugins(
  options: RegisterBuiltinPluginsOptions = {}
): Array<{ name: string; plugin: import('@oa/plugins').IPlugin }> {
  const plugins: Array<{ name: string; plugin: import('@oa/plugins').IPlugin }> = [];

  if (options.riskControl !== false) {
    plugins.push({ name: 'risk-control', plugin: createRiskControlPlugin(options.riskControlConfig) });
  }
  if (options.memoryLayer !== false) {
    plugins.push({ name: 'memory-layer', plugin: createMemoryLayerPlugin(options.memoryLayerConfig) });
  }
  if (options.compaction !== false) {
    plugins.push({ name: 'compaction', plugin: createCompactionPlugin(options.compactionConfig) });
  }
  if (options.security !== false) {
    plugins.push({ name: 'security', plugin: createSecurityPlugin(options.securityConfig) });
  }

  return plugins;
}

/**
 * Create all built-in tools as an array.
 */
export function createAllBuiltinTools(
  options: RegisterBuiltinToolsOptions = {}
): import('@oa/tools').ToolDefinition[] {
  const tools: import('@oa/tools').ToolDefinition[] = [];

  if (options.shell !== false) {
    tools.push(options.restrictedShell ? createRestrictedShellExecTool() : createShellExecTool());
  }
  if (options.fileTools !== false) {
    tools.push(...createAllFileTools());
  }
  if (options.searchTools !== false) {
    tools.push(...createAllSearchTools());
  }
  if (options.askUser !== false) {
    tools.push(createAskUserTool());
  }
  if (options.skillLoad !== false) {
    tools.push(createSkillLoadTool());
  }

  return tools;
}
