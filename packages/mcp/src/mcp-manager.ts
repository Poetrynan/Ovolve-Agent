/**
 * MCPManager — Central manager for all MCP server connections.
 *
 * Handles initialization, connection lifecycle, tool discovery,
 * and tool registration with the global ToolRegistry.
 */

import { EventEmitter } from 'events';
import type {
  McpConfig,
  McpServerConfig,
  McpServerConnection,
  McpTool,
  McpToolResult,
  McpConnectionEvent,
  CallToolOptions,
  RiskLevel,
} from './types.js';
import { McpServerConnection as Connection } from './connection.js';
import { McpToolWrapper, wrapServerTools } from './tool-wrapper.js';

/** Tool registry interface (provided by @oa/tools) */
export interface ToolRegistry {
  register(tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    riskLevel: RiskLevel;
    timeout: number;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  }): void;
  unregister(name: string): void;
  has(name: string): boolean;
  get(name: string): unknown;
}

/**
 * MCPManager manages all MCP server connections in OvolveAgent.
 *
 * Responsibilities:
 * - Initialize connections from config
 * - Connect/disconnect individual servers
 * - Discover and register tools with ToolRegistry
 * - Route tool calls to the correct server
 * - Monitor connection health
 */
export class MCPManager extends EventEmitter {
  private config: McpConfig;
  private connections: Map<string, Connection> = new Map();
  private toolWrappers: Map<string, McpToolWrapper> = new Map();
  private toolRegistry: ToolRegistry | null = null;
  private initialized: boolean = false;
  private defaultTimeout: number;
  private defaultRiskLevel: RiskLevel;

  constructor(config: McpConfig, options?: { toolRegistry?: ToolRegistry; defaultRiskLevel?: RiskLevel }) {
    super();
    this.config = config;
    this.toolRegistry = options?.toolRegistry ?? null;
    this.defaultTimeout = config.defaultTimeout ?? 60000;
    this.defaultRiskLevel = options?.defaultRiskLevel ?? 'MEDIUM';
  }

  /**
   * Initialize the MCP manager: load config and connect to all enabled servers.
   */
  async initialize(config?: McpConfig): Promise<void> {
    if (config) {
      this.config = config;
    }

    if (this.config.enabled === false) {
      this.emit('disabled');
      return;
    }

    this.initialized = true;
    this.emit('initializing');

    // Create connection instances for all configured servers
    for (const [name, serverConfig] of Object.entries(this.config.servers)) {
      if (serverConfig.enabled !== false) {
        const connection = new Connection(serverConfig);
        this.setupConnectionListeners(connection, name);
        this.connections.set(name, connection);
      }
    }

    // Connect to all servers concurrently
    const connectPromises = Array.from(this.connections.entries()).map(
      async ([name, connection]) => {
        try {
          await connection.connect();
          this.registerServerTools(connection);
          this.emit('server_connected', name);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.emit('server_connection_failed', name, error);
        }
      },
    );

    await Promise.allSettled(connectPromises);
    this.emit('initialized');
  }

  /**
   * Connect to a specific MCP server by name.
   */
  async connect(serverName: string): Promise<void> {
    let connection = this.connections.get(serverName);

    if (!connection) {
      // Server not in config — check if we have a config for it
      const serverConfig = this.config.servers[serverName];
      if (!serverConfig) {
        throw new Error(`Unknown MCP server: ${serverName}`);
      }

      connection = new Connection(serverConfig);
      this.setupConnectionListeners(connection, serverName);
      this.connections.set(serverName, connection);
    }

    await connection.connect();
    this.registerServerTools(connection);
    this.emit('server_connected', serverName);
  }

  /**
   * Disconnect from a specific MCP server.
   */
  async disconnect(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }

    // Unregister tools
    this.unregisterServerTools(serverName);

    await connection.disconnect();
    this.emit('server_disconnected', serverName);
  }

  /**
   * List all configured MCP servers and their connection status.
   */
  listServers(): McpServerConnection[] {
    const servers: McpServerConnection[] = [];

    for (const [name, connection] of this.connections) {
      servers.push(connection.getConnectionInfo());
    }

    // Include configured but not yet connected servers
    for (const [name, config] of Object.entries(this.config.servers)) {
      if (!this.connections.has(name)) {
        servers.push({
          name,
          state: 'idle',
          transport: config.transport.type,
          tools: [],
          resources: [],
          prompts: [],
          reconnectAttempts: 0,
        });
      }
    }

    return servers;
  }

  /**
   * List tools available from a specific server.
   */
  listTools(serverName: string): McpTool[] {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }

    return connection.getTools();
  }

  /**
   * List all tools from all connected servers.
   */
  listAllTools(): Array<{ serverName: string; tools: McpTool[] }> {
    const result: Array<{ serverName: string; tools: McpTool[] }> = [];

    for (const [name, connection] of this.connections) {
      if (connection.getState() === 'connected') {
        result.push({
          serverName: name,
          tools: connection.getTools(),
        });
      }
    }

    return result;
  }

  /**
   * Call a tool on a specific MCP server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: CallToolOptions,
  ): Promise<McpToolResult> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }

    if (connection.getState() !== 'connected') {
      throw new Error(`Server ${serverName} is not connected (state: ${connection.getState()})`);
    }

    return connection.callTool(toolName, args, options);
  }

  /**
   * Call a tool using the full mcp__<server>__<tool> name format.
   */
  async callToolByFullName(
    fullName: string,
    args: Record<string, unknown>,
    options?: CallToolOptions,
  ): Promise<McpToolResult> {
    const parsed = this.parseToolName(fullName);
    return this.callTool(parsed.serverName, parsed.toolName, args, options);
  }

  /**
   * Get a specific server connection.
   */
  getConnection(serverName: string): Connection | undefined {
    return this.connections.get(serverName);
  }

  /**
   * Get all connection events for audit trail.
   */
  getConnectionEvents(serverName?: string): McpConnectionEvent[] {
    if (serverName) {
      const connection = this.connections.get(serverName);
      return connection?.getConnectionEvents() ?? [];
    }

    const events: McpConnectionEvent[] = [];
    for (const connection of this.connections.values()) {
      events.push(...connection.getConnectionEvents());
    }
    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Check if a tool name is an MCP tool (starts with mcp__).
   */
  isMcpTool(toolName: string): boolean {
    return toolName.startsWith('mcp__');
  }

  /**
   * Parse a full tool name into server and tool components.
   */
  parseToolName(fullName: string): { serverName: string; toolName: string } {
    if (!fullName.startsWith('mcp__')) {
      throw new Error(`Invalid MCP tool name: ${fullName}`);
    }

    const parts = fullName.slice(5).split('__');
    if (parts.length < 2) {
      throw new Error(`Invalid MCP tool name format: ${fullName}`);
    }

    return {
      serverName: parts[0],
      toolName: parts.slice(1).join('__'),
    };
  }

  /**
   * Shutdown all connections and cleanup.
   */
  async shutdown(): Promise<void> {
    this.emit('shutting_down');

    const disconnectPromises = Array.from(this.connections.entries()).map(
      async ([name, connection]) => {
        try {
          this.unregisterServerTools(name);
          await connection.disconnect();
        } catch {
          // Ignore errors during shutdown
        }
      },
    );

    await Promise.allSettled(disconnectPromises);

    this.connections.clear();
    this.toolWrappers.clear();
    this.initialized = false;

    this.emit('shutdown');
  }

  /**
   * Check if the manager is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the number of connected servers.
   */
  getConnectedCount(): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      if (connection.getState() === 'connected') {
        count++;
      }
    }
    return count;
  }

  /**
   * Set the tool registry (for late binding).
   */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  /**
   * Set up event listeners for a connection.
   */
  private setupConnectionListeners(connection: Connection, name: string): void {
    connection.on('connected', () => {
      this.emit('server_connected', name);
    });

    connection.on('disconnected', () => {
      this.emit('server_disconnected', name);
    });

    connection.on('failed', (err: Error) => {
      this.emit('server_failed', name, err);
    });

    connection.on('reconnecting', (attempt: number) => {
      this.emit('server_reconnecting', name, attempt);
    });

    connection.on('connection_lost', () => {
      this.emit('server_connection_lost', name);
    });

    connection.on('heartbeat', () => {
      this.emit('server_heartbeat', name);
    });

    connection.on('server_notification', (method: unknown, params: unknown) => {
      this.emit('server_notification', name, method, params);
    });
  }

  /**
   * Register all tools from a server connection with the ToolRegistry.
   */
  private registerServerTools(connection: Connection): void {
    if (!this.toolRegistry) return;

    const wrappers = wrapServerTools(connection, {
      timeout: this.defaultTimeout,
      riskLevel: this.defaultRiskLevel,
    });

    for (const wrapper of wrappers) {
      const registration = wrapper.getRegistration();
      this.toolRegistry.register({
        name: registration.name,
        description: registration.description,
        inputSchema: registration.inputSchema,
        riskLevel: registration.riskLevel,
        timeout: registration.timeout,
        handler: wrapper.createHandler(),
      });
      this.toolWrappers.set(registration.name, wrapper);
    }
  }

  /**
   * Unregister all tools from a server.
   */
  private unregisterServerTools(serverName: string): void {
    if (!this.toolRegistry) return;

    for (const [name, wrapper] of this.toolWrappers) {
      if (wrapper.getServerName() === serverName) {
        this.toolRegistry.unregister(name);
        this.toolWrappers.delete(name);
      }
    }
  }
}

/**
 * Factory function to create an MCPManager instance.
 */
export function createMcpManager(
  config: McpConfig,
  options?: { toolRegistry?: ToolRegistry; defaultRiskLevel?: RiskLevel },
): MCPManager {
  return new MCPManager(config, options);
}
