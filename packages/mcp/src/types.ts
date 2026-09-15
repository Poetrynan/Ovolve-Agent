/**
 * @oa/mcp — MCP Bridge types
 *
 * Type definitions for external MCP server integration.
 * Supports 4 transports: stdio, http (Streamable HTTP), sse, websocket.
 */

/** Supported transport types for MCP connections */
export type TransportType = 'stdio' | 'http' | 'sse' | 'websocket';

/** Connection state machine states */
export type ConnectionState =
  | 'idle'
  | 'starting'
  | 'connected'
  | 'failed'
  | 'lost';

/** Risk levels for tool execution */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Stdio transport configuration */
export interface StdioConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Streamable HTTP transport configuration */
export interface HttpConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
}

/** Server-Sent Events transport configuration */
export interface SseConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  reconnectInterval?: number;
}

/** WebSocket transport configuration */
export interface WebSocketConfig {
  type: 'websocket';
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
}

/** Union of all transport configurations */
export type TransportConfig = StdioConfig | HttpConfig | SseConfig | WebSocketConfig;

/** Individual MCP server configuration */
export interface McpServerConfig {
  /** Server name (unique identifier) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Transport configuration */
  transport: TransportConfig;
  /** Whether this server is enabled */
  enabled?: boolean;
  /** Connection timeout in milliseconds */
  timeout?: number;
  /** Heartbeat interval in milliseconds (default 30000) */
  heartbeatInterval?: number;
  /** Heartbeat timeout in milliseconds (default 10000) */
  heartbeatTimeout?: number;
  /** Number of retry attempts on connection failure */
  retries?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Top-level MCP configuration */
export interface McpConfig {
  /** Map of server name to server configuration */
  servers: Record<string, McpServerConfig>;
  /** Global default timeout */
  defaultTimeout?: number;
  /** Global heartbeat interval */
  defaultHeartbeatInterval?: number;
  /** Global heartbeat timeout */
  defaultHeartbeatTimeout?: number;
  /** Whether MCP is globally enabled */
  enabled?: boolean;
}

/** MCP tool definition */
export interface McpTool {
  /** Tool name (without server prefix) */
  name: string;
  /** Tool description */
  description?: string;
  /** JSON Schema for input validation */
  inputSchema?: Record<string, unknown>;
  /** Annotations from MCP server */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** MCP resource definition */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** MCP prompt definition */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** Tool call result */
export interface McpToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }
  >;
  isError?: boolean;
}

/** Server connection information */
export interface McpServerConnection {
  /** Server name */
  name: string;
  /** Current connection state */
  state: ConnectionState;
  /** Transport type in use */
  transport: TransportType;
  /** Available tools */
  tools: McpTool[];
  /** Available resources */
  resources: McpResource[];
  /** Available prompts */
  prompts: McpPrompt[];
  /** Last error if any */
  lastError?: string;
  /** Connection timestamp */
  connectedAt?: number;
  /** Last heartbeat timestamp */
  lastHeartbeat?: number;
  /** Number of reconnection attempts */
  reconnectAttempts: number;
}

/** Connection event for audit trail */
export interface McpConnectionEvent {
  timestamp: number;
  serverName: string;
  event: 'connect' | 'disconnect' | 'reconnect' | 'error' | 'heartbeat' | 'tool_call';
  details?: Record<string, unknown>;
}

/** Options for calling an MCP tool */
export interface CallToolOptions {
  /** Timeout override in milliseconds */
  timeout?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Additional metadata to pass through */
  metadata?: Record<string, unknown>;
}

/** Wrapped tool registration info for ToolRegistry */
export interface WrappedToolRegistration {
  /** Full tool name: mcp__<server>__<tool> */
  name: string;
  /** Original server name */
  serverName: string;
  /** Original tool name */
  toolName: string;
  /** Tool description */
  description: string;
  /** Input JSON schema */
  inputSchema: Record<string, unknown>;
  /** Risk level */
  riskLevel: RiskLevel;
  /** Timeout in milliseconds */
  timeout: number;
}
