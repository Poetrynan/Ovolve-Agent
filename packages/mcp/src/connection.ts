/**
 * McpServerConnection — Manages a single MCP server connection.
 *
 * Implements a state machine: idle → starting → connected → failed → lost
 * with heartbeat probing, graceful degradation, and tool registration.
 */

import { EventEmitter } from 'events';
import type {
  McpServerConfig,
  McpServerConnection,
  McpTool,
  McpResource,
  McpPrompt,
  McpToolResult,
  ConnectionState,
  TransportType,
  McpConnectionEvent,
  CallToolOptions,
} from './types.js';
import { StdioTransport } from './transports/stdio.js';
import { HttpTransport } from './transports/http.js';
import { SseTransport } from './transports/sse.js';
import { WebSocketTransport } from './transports/websocket.js';

/** Transport interface common to all transport implementations */
interface Transport {
  isConnected(): boolean;
  connect(): Promise<void>;
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * McpServerConnection manages the lifecycle of a single MCP server connection.
 *
 * State machine:
 * - idle: Initial state, not connected
 * - starting: Connection in progress
 * - connected: Active and healthy
 * - failed: Connection failed, will retry
 * - lost: Connection was lost after being connected
 */
export class McpServerConnection extends EventEmitter {
  private config: McpServerConfig;
  private transport: Transport | null = null;
  private state: ConnectionState = 'idle';
  private tools: Map<string, McpTool> = new Map();
  private resources: Map<string, McpResource> = new Map();
  private prompts: Map<string, McpPrompt> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: number;
  private heartbeatTimeout: number;
  private heartbeatTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private lastHeartbeat: number = 0;
  private reconnectAttempts: number = 0;
  private maxRetries: number;
  private connectionEvents: McpConnectionEvent[] = [];
  private toolRegistrations: Map<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = new Map();

  constructor(config: McpServerConfig) {
    super();
    this.config = config;
    this.heartbeatInterval = config.heartbeatInterval ?? 30000;
    this.heartbeatTimeout = config.heartbeatTimeout ?? 10000;
    this.maxRetries = config.retries ?? 3;
  }

  /** Get the server name */
  getName(): string {
    return this.config.name;
  }

  /** Get the current connection state */
  getState(): ConnectionState {
    return this.state;
  }

  /** Get the transport type */
  getTransportType(): TransportType {
    return this.config.transport.type;
  }

  /** Get connection info snapshot */
  getConnectionInfo(): McpServerConnection {
    return {
      name: this.config.name,
      state: this.state,
      transport: this.config.transport.type,
      tools: Array.from(this.tools.values()),
      resources: Array.from(this.resources.values()),
      prompts: Array.from(this.prompts.values()),
      lastError: this.state === 'failed' ? 'Connection failed' : undefined,
      connectedAt: this.lastHeartbeat > 0 ? this.lastHeartbeat - 1000 : undefined,
      lastHeartbeat: this.lastHeartbeat > 0 ? this.lastHeartbeat : undefined,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /** Get available tools */
  getTools(): McpTool[] {
    return Array.from(this.tools.values());
  }

  /** Get available resources */
  getResources(): McpResource[] {
    return Array.from(this.resources.values());
  }

  /** Get available prompts */
  getPrompts(): McpPrompt[] {
    return Array.from(this.prompts.values());
  }

  /** Get connection event history */
  getConnectionEvents(): McpConnectionEvent[] {
    return [...this.connectionEvents];
  }

  /**
   * Connect to the MCP server.
   * Transitions: idle → starting → connected
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'starting') {
      return;
    }

    this.setState('starting');
    this.emit('connecting');

    try {
      this.transport = this.createTransport();
      this.setupTransportListeners();
      await this.transport.connect();

      // Initialize the MCP session
      await this.initializeSession();

      // Discover tools, resources, and prompts
      await this.discoverCapabilities();

      this.setState('connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.recordEvent('connect');
      this.emit('connected');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.setState('failed');
      this.recordEvent('error', { error: error.message });
      this.emit('failed', error);
      throw error;
    }
  }

  /**
   * Disconnect from the server.
   */
  async disconnect(): Promise<void> {
    this.stopHeartbeat();

    if (this.transport) {
      await this.transport.disconnect();
      this.transport = null;
    }

    this.setState('idle');
    this.recordEvent('disconnect');
    this.emit('disconnected');
  }

  /**
   * Call a tool on the remote MCP server.
   */
  async callTool(toolName: string, args: Record<string, unknown>, options?: CallToolOptions): Promise<McpToolResult> {
    if (this.state !== 'connected') {
      throw new Error(`Server ${this.config.name} is not connected (state: ${this.state})`);
    }

    const timeout = options?.timeout ?? this.config.timeout ?? 60000;

    try {
      const result = await this.transport!.request(
        'tools/call',
        { name: toolName, arguments: args },
        timeout,
      ) as McpToolResult;

      this.recordEvent('tool_call', { tool: toolName, success: !result.isError });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.recordEvent('tool_call', { tool: toolName, success: false, error: error.message });
      throw error;
    }
  }

  /**
   * Read a resource from the MCP server.
   */
  async readResource(uri: string): Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }> {
    if (this.state !== 'connected') {
      throw new Error(`Server ${this.config.name} is not connected`);
    }

    return this.transport!.request('resources/read', { uri }) as Promise<{
      contents: Array<{ uri: string; mimeType?: string; text?: string }>;
    }>;
  }

  /**
   * Get a prompt from the MCP server.
   */
  async getPrompt(name: string, arguments_?: Record<string, string>): Promise<{
    description?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: { type: string; text: string } }>;
  }> {
    if (this.state !== 'connected') {
      throw new Error(`Server ${this.config.name} is not connected`);
    }

    return this.transport!.request('prompts/get', { name, arguments: arguments_ }) as Promise<{
      description?: string;
      messages: Array<{ role: 'user' | 'assistant'; content: { type: string; text: string } }>;
    }>;
  }

  /**
   * Register a tool handler for local invocation.
   * Returns a callable that wraps the remote tool call.
   */
  registerToolHandler(toolName: string): (args: Record<string, unknown>) => Promise<McpToolResult> {
    const handler = async (args: Record<string, unknown>): Promise<McpToolResult> => {
      return this.callTool(toolName, args);
    };
    this.toolRegistrations.set(toolName, handler);
    return handler;
  }

  /**
   * Get all registered tool handlers.
   */
  getToolHandlers(): Map<string, (args: Record<string, unknown>) => Promise<McpToolResult>> {
    return new Map(this.toolRegistrations);
  }

  /**
   * Check if the connection is healthy.
   */
  isHealthy(): boolean {
    return this.state === 'connected' && this.transport?.isConnected() === true;
  }

  /**
   * Attempt to reconnect with exponential backoff.
   */
  async reconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxRetries) {
      this.setState('failed');
      this.emit('failed', new Error('Max reconnection attempts reached'));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);

    this.recordEvent('reconnect', { attempt: this.reconnectAttempts, delay });
    this.emit('reconnecting', this.reconnectAttempts);

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await this.connect();
    } catch {
      // Reconnect failure handled by state transition
    }
  }

  /**
   * Create the appropriate transport based on config.
   */
  private createTransport(): Transport {
    switch (this.config.transport.type) {
      case 'stdio':
        return new StdioTransport(this.config.transport);
      case 'http':
        return new HttpTransport(this.config.transport);
      case 'sse':
        return new SseTransport(this.config.transport);
      case 'websocket':
        return new WebSocketTransport(this.config.transport);
      default:
        throw new Error(`Unsupported transport type: ${(this.config.transport as { type: string }).type}`);
    }
  }

  /**
   * Set up transport event listeners.
   */
  private setupTransportListeners(): void {
    if (!this.transport) return;

    this.transport.on('error', (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('transport_error', error);
    });

    this.transport.on('unexpected_exit', (...args: unknown[]) => {
      this.handleConnectionLoss();
    });

    this.transport.on('connection_lost', () => {
      this.handleConnectionLoss();
    });

    this.transport.on('notification', (method: unknown, params: unknown) => {
      this.emit('server_notification', method, params);
    });
  }

  /**
   * Handle unexpected connection loss.
   */
  private handleConnectionLoss(): void {
    if (this.state !== 'connected') return;

    this.setState('lost');
    this.stopHeartbeat();
    this.recordEvent('error', { error: 'Connection lost' });
    this.emit('connection_lost');

    // Attempt reconnection
    this.reconnect().catch(() => {
      // Reconnection handled internally
    });
  }

  /**
   * Initialize the MCP session with the server.
   */
  private async initializeSession(): Promise<void> {
    const result = await this.transport!.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'ovolveagent-mcp-bridge',
        version: '1.0.0',
      },
    }) as {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo: { name: string; version: string };
    };

    // Send initialized notification
    this.transport!.notify('notifications/initialized');

    this.emit('session_initialized', result);
  }

  /**
   * Discover server capabilities: tools, resources, prompts.
   */
  private async discoverCapabilities(): Promise<void> {
    // List tools
    try {
      const toolsResult = await this.transport!.request('tools/list', {}) as {
        tools: McpTool[];
      };
      this.tools.clear();
      for (const tool of toolsResult.tools) {
        this.tools.set(tool.name, tool);
        this.registerToolHandler(tool.name);
      }
    } catch {
      // Tools listing may not be supported
    }

    // List resources
    try {
      const resourcesResult = await this.transport!.request('resources/list', {}) as {
        resources: McpResource[];
      };
      this.resources.clear();
      for (const resource of resourcesResult.resources) {
        this.resources.set(resource.uri, resource);
      }
    } catch {
      // Resources may not be supported
    }

    // List prompts
    try {
      const promptsResult = await this.transport!.request('prompts/list', {}) as {
        prompts: McpPrompt[];
      };
      this.prompts.clear();
      for (const prompt of promptsResult.prompts) {
        this.prompts.set(prompt.name, prompt);
      }
    } catch {
      // Prompts may not be supported
    }
  }

  /**
   * Start the heartbeat probe interval.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastHeartbeat = Date.now();

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatInterval);
  }

  /**
   * Stop the heartbeat probe.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutHandle) {
      clearTimeout(this.heartbeatTimeoutHandle);
      this.heartbeatTimeoutHandle = null;
    }
  }

  /**
   * Send a heartbeat ping to verify the connection is alive.
   */
  private async sendHeartbeat(): Promise<void> {
    if (this.state !== 'connected') return;

    this.heartbeatTimeoutHandle = setTimeout(() => {
      // Heartbeat timed out — connection is dead
      this.handleConnectionLoss();
    }, this.heartbeatTimeout);

    try {
      await this.transport!.request('ping', {}, this.heartbeatTimeout);
      // Heartbeat succeeded
      if (this.heartbeatTimeoutHandle) {
        clearTimeout(this.heartbeatTimeoutHandle);
        this.heartbeatTimeoutHandle = null;
      }
      this.lastHeartbeat = Date.now();
      this.recordEvent('heartbeat');
      this.emit('heartbeat');
    } catch {
      // Heartbeat failed
      if (this.heartbeatTimeoutHandle) {
        clearTimeout(this.heartbeatTimeoutHandle);
        this.heartbeatTimeoutHandle = null;
      }
      this.handleConnectionLoss();
    }
  }

  /**
   * Transition to a new state.
   */
  private setState(newState: ConnectionState): void {
    const oldState = this.state;
    this.state = newState;
    this.emit('state_change', oldState, newState);
  }

  /**
   * Record a connection event for audit trail.
   */
  private recordEvent(
    event: McpConnectionEvent['event'],
    details?: Record<string, unknown>,
  ): void {
    this.connectionEvents.push({
      timestamp: Date.now(),
      serverName: this.config.name,
      event,
      details,
    });

    // Keep only the last 1000 events
    if (this.connectionEvents.length > 1000) {
      this.connectionEvents = this.connectionEvents.slice(-1000);
    }
  }
}
