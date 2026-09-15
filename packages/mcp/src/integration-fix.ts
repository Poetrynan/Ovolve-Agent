/**
 * @oa/mcp — Integration Fix
 *
 * Additional exports and type bridges needed by other packages.
 * Ensures interface alignment across the monorepo.
 */

import type {
  McpServerConfig,
  McpConfig,
  McpTool,
  McpResource,
  McpPrompt,
  McpServerConnection,
  TransportType,
  TransportConfig,
  WrappedToolRegistration,
} from './types';

// ---------------------------------------------------------------------------
// Re-exports for cross-package compatibility
// ---------------------------------------------------------------------------

export type {
  McpServerConfig,
  McpConfig,
  McpTool,
  McpResource,
  McpPrompt,
  McpServerConnection,
  TransportConfig,
  WrappedToolRegistration,
};

export type { TransportType } from './types';

// ---------------------------------------------------------------------------
// MCP tool to tools package bridge
// ---------------------------------------------------------------------------

/**
 * Convert an MCP tool to a WrappedToolRegistration for the tools package.
 */
export function toWrappedToolRegistration(
  serverName: string,
  tool: McpTool,
  options?: {
    riskLevel?: import('@oa/plugins').RiskLevel;
    timeout?: number;
  }
): WrappedToolRegistration {
  return {
    name: `mcp__${serverName}__${tool.name}`,
    serverName,
    toolName: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    riskLevel: (options?.riskLevel ?? 'MEDIUM') as import('@oa/plugins').RiskLevel,
    timeout: options?.timeout ?? 30000,
  };
}

/**
 * Convert a WrappedToolRegistration to tools package ToolDefinition.
 */
export function toToolsPackageToolDefinition(
  registration: WrappedToolRegistration
): import('@oa/tools').ToolDefinition {
  return {
    name: registration.name,
    description: registration.description,
    inputSchema: registration.inputSchema as import('@oa/tools').InputSchema,
    executionMode: 'SEQUENTIAL' as import('@oa/tools').ToolExecutionMode,
    riskLevel: registration.riskLevel,
    scope: 'GLOBAL' as import('@oa/tools').ToolScope,
    requiresConfirmation: false,
    timeoutMs: registration.timeout,
    retryable: true,
    maxRetries: 2,
    execute: async () => ({
      success: true,
      content: [],
      metadata: { toolName: registration.name, durationMs: 0, retryCount: 0, truncated: false },
    }),
  };
}

// ---------------------------------------------------------------------------
// McpConfig helpers
// ---------------------------------------------------------------------------

/**
 * Create a McpConfig with defaults.
 */
export function createMcpConfig(
  servers?: Record<string, McpServerConfig>
): McpConfig {
  return {
    servers: servers ?? {},
    defaultTimeout: 30000,
    defaultHeartbeatInterval: 30000,
    defaultHeartbeatTimeout: 10000,
    enabled: true,
  };
}

/**
 * Validate a McpConfig.
 */
export function validateMcpConfig(config: McpConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const [name, server] of Object.entries(config.servers)) {
    if (!name) {
      errors.push('Server name cannot be empty');
    }
    if (!server.transport) {
      errors.push(`Server "${name}" missing transport configuration`);
    }
    if (server.transport.type === 'stdio' && !server.transport.command) {
      errors.push(`Server "${name}" stdio transport missing command`);
    }
    if ((server.transport.type === 'http' || server.transport.type === 'sse' || server.transport.type === 'websocket') && !server.transport.url) {
      errors.push(`Server "${name}" ${server.transport.type} transport missing URL`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

/**
 * Check if a transport type is network-based.
 */
export function isNetworkTransport(type: TransportType): boolean {
  return type === 'http' || type === 'sse' || type === 'websocket';
}

/**
 * Check if a transport type is stdio-based.
 */
export function isStdioTransport(type: TransportType): boolean {
  return type === 'stdio';
}
