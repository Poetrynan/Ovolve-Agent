/**
 * @oa/mcp — MCP (Model Context Protocol) Bridge for OvolveAgent
 *
 * Provides integration with external MCP servers via multiple transports.
 */

// Types
export type {
  TransportType,
  ConnectionState,
  RiskLevel,
  StdioConfig,
  HttpConfig,
  SseConfig,
  WebSocketConfig,
  TransportConfig,
  McpServerConfig,
  McpConfig,
  McpTool,
  McpResource,
  McpPrompt,
  McpToolResult,
  McpServerConnection,
  McpConnectionEvent,
  CallToolOptions,
  WrappedToolRegistration,
} from './types';

// Stdio transport
export { StdioTransport, createStdioTransport } from './transports/stdio';

// MCP Manager
export interface McpManager {
  connect(serverName: string): Promise<void>;
  disconnect(serverName: string): Promise<void>;
  disconnectAll(): Promise<void>;
  listConnections(): McpServerConnection[];
  listTools(serverName?: string): McpTool[];
  listAllTools(): McpTool[];
  callTool(serverName: string, toolName: string, args: Record<string, unknown>, options?: CallToolOptions): Promise<McpToolResult>;
  getConnection(serverName: string): McpServerConnection | null;
  isEnabled(): boolean;
}

export interface McpManagerConfig {
  mcpConfig: McpConfig;
  toolRegistry?: import('@oa/tools').ToolRegistry;
}

export class McpManagerImpl implements McpManager {
  private config: McpConfig;
  private connections: Map<string, McpServerConnection> = new Map();
  private transports: Map<string, StdioTransport> = new Map();
  private toolRegistry?: import('@oa/tools').ToolRegistry;

  constructor(config: McpManagerConfig) {
    this.config = config.mcpConfig;
    this.toolRegistry = config.toolRegistry;
  }

  async connect(serverName: string): Promise<void> {
    const serverConfig = this.config.servers[serverName];
    if (!serverConfig) throw new Error(`MCP server not found: ${serverName}`);

    if (serverConfig.transport.type === 'stdio') {
      const transport = createStdioTransport(serverConfig.transport);
      await transport.connect();

      const connection: McpServerConnection = {
        name: serverName,
        state: 'connected',
        transport: 'stdio',
        tools: [],
        resources: [],
        prompts: [],
        reconnectAttempts: 0,
        connectedAt: Date.now(),
      };

      this.connections.set(serverName, connection);
      this.transports.set(serverName, transport);
    }
  }

  async disconnect(serverName: string): Promise<void> {
    const transport = this.transports.get(serverName);
    if (transport) {
      await transport.disconnect();
      this.transports.delete(serverName);
    }

    const connection = this.connections.get(serverName);
    if (connection) {
      connection.state = 'lost';
      this.connections.delete(serverName);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const serverName of this.transports.keys()) {
      await this.disconnect(serverName);
    }
  }

  listConnections(): McpServerConnection[] {
    return Array.from(this.connections.values());
  }

  listTools(serverName?: string): McpTool[] {
    if (serverName) {
      const connection = this.connections.get(serverName);
      return connection?.tools ?? [];
    }
    return this.listAllTools();
  }

  listAllTools(): McpTool[] {
    const tools: McpTool[] = [];
    for (const connection of this.connections.values()) {
      tools.push(...connection.tools);
    }
    return tools;
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: CallToolOptions
  ): Promise<McpToolResult> {
    const transport = this.transports.get(serverName);
    if (!transport) throw new Error(`Not connected to MCP server: ${serverName}`);

    const result = await transport.request('tools/call', { name: toolName, arguments: args }, options?.timeout ?? 30000);
    return result as McpToolResult;
  }

  getConnection(serverName: string): McpServerConnection | null {
    return this.connections.get(serverName) ?? null;
  }

  isEnabled(): boolean {
    return this.config.enabled ?? true;
  }
}

export function createMcpManager(config: McpManagerConfig): McpManager {
  return new McpManagerImpl(config);
}

// Integration helpers
export {
  toWrappedToolRegistration,
  toToolsPackageToolDefinition,
  createMcpConfig,
  validateMcpConfig,
  isNetworkTransport,
  isStdioTransport,
} from './integration-fix';
