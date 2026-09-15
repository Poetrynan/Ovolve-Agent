/**
 * Tool wrapper for MCP tools.
 *
 * Wraps remote MCP tools as local tools that can be registered
 * with the global ToolRegistry. Naming convention: mcp__<server>__<tool>
 */

import type {
  McpTool,
  McpToolResult,
  RiskLevel,
  WrappedToolRegistration,
  CallToolOptions,
} from './types.js';
import type { McpServerConnection } from './connection.js';

/** Tool handler function type */
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** Tool metadata for registration */
export interface ToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: RiskLevel;
  timeout: number;
  serverName: string;
  toolName: string;
}

/**
 * Wraps an MCP tool as a local tool with standardized naming and metadata.
 *
 * Naming convention: mcp__<server>__<tool>
 * Default risk level: MEDIUM
 * Default timeout: 60 seconds
 */
export class McpToolWrapper {
  private connection: McpServerConnection;
  private tool: McpTool;
  private serverName: string;
  private timeout: number;
  private riskLevel: RiskLevel;

  constructor(
    connection: McpServerConnection,
    tool: McpTool,
    options?: {
      timeout?: number;
      riskLevel?: RiskLevel;
    },
  ) {
    this.connection = connection;
    this.tool = tool;
    this.serverName = connection.getName();
    this.timeout = options?.timeout ?? 60000;
    this.riskLevel = options?.riskLevel ?? 'MEDIUM';
  }

  /** Get the full tool name: mcp__<server>__<tool> */
  getFullName(): string {
    return `mcp__${this.serverName}__${this.tool.name}`;
  }

  /** Get the original tool name (without prefix) */
  getToolName(): string {
    return this.tool.name;
  }

  /** Get the server name */
  getServerName(): string {
    return this.serverName;
  }

  /** Get tool metadata */
  getMetadata(): ToolMetadata {
    return {
      name: this.getFullName(),
      description: this.tool.description ?? `MCP tool: ${this.tool.name} (server: ${this.serverName})`,
      inputSchema: this.tool.inputSchema ?? { type: 'object', properties: {} },
      riskLevel: this.riskLevel,
      timeout: this.timeout,
      serverName: this.serverName,
      toolName: this.tool.name,
    };
  }

  /**
   * Execute the tool with given arguments.
   * Validates input against the tool's input schema.
   */
  async execute(args: Record<string, unknown>, options?: CallToolOptions): Promise<unknown> {
    // Validate input schema if available
    if (this.tool.inputSchema) {
      this.validateInput(args, this.tool.inputSchema);
    }

    const result = await this.connection.callTool(this.tool.name, args, {
      timeout: options?.timeout ?? this.timeout,
      signal: options?.signal,
      metadata: options?.metadata,
    });

    return this.processResult(result);
  }

  /**
   * Get registration info for the ToolRegistry.
   */
  getRegistration(): WrappedToolRegistration {
    return {
      name: this.getFullName(),
      serverName: this.serverName,
      toolName: this.tool.name,
      description: this.tool.description ?? `MCP tool: ${this.tool.name}`,
      inputSchema: this.tool.inputSchema ?? { type: 'object', properties: {} },
      riskLevel: this.riskLevel,
      timeout: this.timeout,
    };
  }

  /**
   * Create a callable handler for this tool.
   */
  createHandler(): ToolHandler {
    return async (args: Record<string, unknown>): Promise<unknown> => {
      return this.execute(args);
    };
  }

  /**
   * Validate input arguments against the JSON schema.
   * Performs basic validation (required fields, type checking).
   */
  private validateInput(args: Record<string, unknown>, schema: Record<string, unknown>): void {
    const properties = schema.properties as Record<string, unknown> | undefined;
    const required = schema.required as string[] | undefined;

    if (required) {
      for (const field of required) {
        if (!(field in args)) {
          throw new Error(`Missing required field: ${field}`);
        }
      }
    }

    if (properties) {
      for (const [key, value] of Object.entries(args)) {
        const propSchema = properties[key] as Record<string, unknown> | undefined;
        if (propSchema && propSchema.type) {
          const expectedType = propSchema.type as string;
          if (!this.matchesType(value, expectedType)) {
            throw new Error(
              `Invalid type for field ${key}: expected ${expectedType}, got ${typeof value}`,
            );
          }
        }
      }
    }
  }

  /**
   * Check if a value matches the expected JSON schema type.
   */
  private matchesType(value: unknown, expectedType: string): boolean {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
      case 'integer':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'null':
        return value === null;
      default:
        return true;
    }
  }

  /**
   * Process the MCP tool result into a standardized format.
   */
  private processResult(result: McpToolResult): unknown {
    if (result.isError) {
      // Extract error message from content
      const errorContent = result.content.find((c) => c.type === 'text');
      throw new Error(`MCP tool error: ${errorContent && 'text' in errorContent ? errorContent.text : 'Unknown error'}`);
    }

    // If there's a single text content, return it directly
    if (result.content.length === 1 && result.content[0].type === 'text') {
      return result.content[0].text;
    }

    // If there's a single image, return it
    if (result.content.length === 1 && result.content[0].type === 'image') {
      return result.content[0];
    }

    // Return full content array for mixed results
    return result.content;
  }
}

/**
 * Wrap multiple MCP tools from a server connection.
 */
export function wrapServerTools(
  connection: McpServerConnection,
  options?: {
    timeout?: number;
    riskLevel?: RiskLevel;
  },
): McpToolWrapper[] {
  const tools = connection.getTools();
  return tools.map((tool) => new McpToolWrapper(connection, tool, options));
}

/**
 * Create a single tool wrapper.
 */
export function wrapTool(
  connection: McpServerConnection,
  tool: McpTool,
  options?: {
    timeout?: number;
    riskLevel?: RiskLevel;
  },
): McpToolWrapper {
  return new McpToolWrapper(connection, tool, options);
}
