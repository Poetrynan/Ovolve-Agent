/**
 * OvolveAgentClient — Main SDK client for OvolveAgent.
 *
 * Provides a unified interface combining:
 * - WebSocket for real-time streaming
 * - REST for CRUD operations and queries
 *
 * Supports multi-mode: interactive, print, JSON, RPC
 */

import { EventEmitter } from 'events';
import type {
  SdkConfig,
  SdkMode,
  Session,
  CreateSessionOptions,
  ChatOptions,
  ChatMessage,
  EventQueryOptions,
  StreamEvent,
  SessionState,
  SearchResult,
  ForkSessionOptions,
  ListSessionsFilter,
  PaginatedResponse,
  ClientStats,
  StreamChunk,
} from './types.js';
import { WebSocketClient } from './websocket-client.js';
import { RESTClient } from './rest-client.js';
import { AsyncStream, createStreamFromEmitter, streamToText } from './stream.js';

/** Default configuration values */
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MODE: SdkMode = 'interactive';

/**
 * OvolveAgentClient is the main entry point for the SDK.
 *
 * It combines WebSocket (streaming) and REST (query) interfaces
 * into a single unified API.
 */
export class OvolveAgentClient extends EventEmitter {
  private config: SdkConfig;
  private wsClient: WebSocketClient;
  private restClient: RESTClient;
  private mode: SdkMode;
  private stats: ClientStats;
  private startTime: number;

  constructor(config: SdkConfig) {
    super();
    this.config = {
      ...config,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      mode: config.mode ?? DEFAULT_MODE,
      reconnectEnabled: config.reconnectEnabled ?? true,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 6,
    };
    this.mode = this.config.mode!;
    this.startTime = Date.now();
    this.stats = {
      sessionsCreated: 0,
      messagesSent: 0,
      messagesReceived: 0,
      toolCalls: 0,
      errors: 0,
      uptime: 0,
      reconnects: 0,
    };

    // Convert HTTP URL to WebSocket URL
    const wsUrl = this.httpToWsUrl(config.serverUrl);

    this.wsClient = new WebSocketClient(wsUrl, {
      reconnectEnabled: this.config.reconnectEnabled,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      authToken: config.authToken,
      apiKey: config.apiKey,
      headers: config.headers,
    });

    this.restClient = new RESTClient(config);

    this.setupWebSocketListeners();
  }

  // ==================== Connection Management ====================

  /**
   * Connect to the OvolveAgent server.
   * Establishes both WebSocket and validates REST connectivity.
   */
  async connect(): Promise<void> {
    this.emit('connecting');

    // Connect WebSocket
    await this.wsClient.connect();

    // Validate REST endpoint
    try {
      await this.restClient.health();
    } catch {
      // REST may not be available; WebSocket is primary
    }

    this.emit('connected');
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    this.wsClient.disconnect();
    this.emit('disconnected');
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.wsClient.isConnected();
  }

  /**
   * Get the current connection state.
   */
  getConnectionState(): string {
    return this.wsClient.getState();
  }

  // ==================== Session Operations ====================

  /**
   * Create a new session.
   */
  async createSession(options?: CreateSessionOptions): Promise<Session> {
    const session = await this.restClient.createSession(options);
    this.stats.sessionsCreated++;
    this.emit('session_created', session);
    return session;
  }

  /**
   * Get a session by ID.
   */
  async getSession(sessionId: string): Promise<Session> {
    return this.restClient.getSession(sessionId);
  }

  /**
   * List sessions with optional filters.
   */
  async listSessions(filter?: ListSessionsFilter): Promise<PaginatedResponse<Session>> {
    return this.restClient.listSessions(filter);
  }

  /**
   * Update a session.
   */
  async updateSession(
    sessionId: string,
    updates: Partial<Pick<Session, 'systemPrompt' | 'metadata' | 'tags' | 'status'>>,
  ): Promise<Session> {
    return this.restClient.updateSession(sessionId, updates);
  }

  /**
   * Delete a session.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.restClient.deleteSession(sessionId);
    this.emit('session_deleted', sessionId);
  }

  /**
   * Fork a session at a specific point.
   */
  async forkSession(sourceId: string, forkPoint: number, options?: Omit<ForkSessionOptions, 'sourceId' | 'forkPoint'>): Promise<Session> {
    const session = await this.restClient.forkSession({
      sourceId,
      forkPoint,
      ...options,
    });
    this.stats.sessionsCreated++;
    this.emit('session_forked', { sourceId, forkPoint, session });
    return session;
  }

  // ==================== Chat Operations ====================

  /**
   * Send a message and receive a streaming response.
   * Returns an AsyncStream for consuming the response.
   */
  async *chat(sessionId: string, message: string, options?: ChatOptions): AsyncGenerator<StreamChunk> {
    this.stats.messagesSent++;

    // Subscribe to session events
    this.wsClient.subscribe(sessionId);

    // Send chat message via WebSocket
    this.wsClient.send({
      type: 'chat',
      payload: {
        sessionId,
        message,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        tools: options?.tools,
        context: options?.context,
      },
    });

    // Create stream from WebSocket events
    const stream = createStreamFromEmitter(this.wsClient, sessionId);

    try {
      for await (const chunk of stream) {
        if (chunk.event.type === 'content_delta' || chunk.event.type === 'message_delta') {
          this.stats.messagesReceived++;
        }
        if (chunk.event.type === 'tool_call_start') {
          this.stats.toolCalls++;
        }
        yield chunk;

        if (chunk.done) break;
      }
    } catch (err) {
      this.stats.errors++;
      throw err;
    }
  }

  /**
   * Send a message and receive the full response (non-streaming).
   */
  async chatSync(sessionId: string, message: string, options?: ChatOptions): Promise<string> {
    const stream = this.chat(sessionId, message, options);
    return streamToText(streamToAsyncIterable(stream));
  }

  /**
   * Send a message in print mode (returns formatted text).
   */
  async chatPrint(sessionId: string, message: string, options?: ChatOptions): Promise<string> {
    const response = await this.chatSync(sessionId, message, options);
    return response;
  }

  /**
   * Send a message in JSON mode (returns structured data).
   */
  async chatJson(sessionId: string, message: string, options?: ChatOptions): Promise<{
    content: string;
    events: StreamEvent[];
    metadata: Record<string, unknown>;
  }> {
    const events: StreamEvent[] = [];
    let content = '';

    for await (const chunk of this.chat(sessionId, message, options)) {
      events.push(chunk.event);
      content = chunk.accumulated;
      if (chunk.done) break;
    }

    return {
      content,
      events,
      metadata: {
        sessionId,
        eventCount: events.length,
        timestamp: Date.now(),
      },
    };
  }

  // ==================== Event Operations ====================

  /**
   * Get events for a session.
   */
  async getEvents(sessionId: string, options?: EventQueryOptions): Promise<PaginatedResponse<StreamEvent>> {
    return this.restClient.getEvents(sessionId, options);
  }

  /**
   * Get the current state of a session.
   */
  async getState(sessionId: string): Promise<SessionState> {
    return this.restClient.getState(sessionId);
  }

  /**
   * Search events within a session.
   */
  async search(sessionId: string, query: string, options?: {
    types?: string[];
    limit?: number;
    caseSensitive?: boolean;
    regex?: boolean;
  }): Promise<SearchResult> {
    return this.restClient.searchEvents(sessionId, query, options);
  }

  // ==================== Control Operations ====================

  /**
   * Pause a session's current turn.
   */
  async pause(sessionId: string): Promise<SessionState> {
    this.wsClient.send({
      type: 'pause',
      payload: { sessionId },
    });
    return this.restClient.pause(sessionId);
  }

  /**
   * Resume a paused session.
   */
  async resume(sessionId: string): Promise<SessionState> {
    this.wsClient.send({
      type: 'resume',
      payload: { sessionId },
    });
    return this.restClient.resume(sessionId);
  }

  /**
   * Stop a session's current turn.
   */
  async stop(sessionId: string): Promise<SessionState> {
    this.wsClient.send({
      type: 'stop',
      payload: { sessionId },
    });
    return this.restClient.stop(sessionId);
  }

  // ==================== Utility Methods ====================

  /**
   * Get client statistics.
   */
  getStats(): ClientStats {
    return {
      ...this.stats,
      uptime: Date.now() - this.startTime,
    };
  }

  /**
   * Get the current mode.
   */
  getMode(): SdkMode {
    return this.mode;
  }

  /**
   * Set the operation mode.
   */
  setMode(mode: SdkMode): void {
    this.mode = mode;
    this.emit('mode_changed', mode);
  }

  /**
   * Get the REST client for advanced operations.
   */
  getRestClient(): RESTClient {
    return this.restClient;
  }

  /**
   * Get the WebSocket client for low-level access.
   */
  getWsClient(): WebSocketClient {
    return this.wsClient;
  }

  /**
   * Health check the server.
   */
  async health(): Promise<{ status: string; version: string; uptime: number }> {
    return this.restClient.health();
  }

  /**
   * Get server info.
   */
  async getServerInfo(): Promise<{ name: string; version: string; capabilities: string[] }> {
    return this.restClient.getServerInfo();
  }

  // ==================== Private Methods ====================

  /**
   * Set up WebSocket event listeners.
   */
  private setupWebSocketListeners(): void {
    this.wsClient.on('connected', () => {
      this.emit('ws_connected');
    });

    this.wsClient.on('disconnected', () => {
      this.emit('ws_disconnected');
    });

    this.wsClient.on('reconnecting', (attempt: number, delay: number) => {
      this.stats.reconnects++;
      this.emit('ws_reconnecting', attempt, delay);
    });

    this.wsClient.on('reconnected', () => {
      this.emit('ws_reconnected');
    });

    this.wsClient.on('reconnect_failed', () => {
      this.emit('ws_reconnect_failed');
    });

    this.wsClient.on('server_error', (error: unknown) => {
      this.stats.errors++;
      this.emit('error', error);
    });

    this.wsClient.on('stream_event', (event: StreamEvent) => {
      this.emit('stream_event', event);
    });
  }

  /**
   * Convert HTTP URL to WebSocket URL.
   */
  private httpToWsUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      parsed.protocol = protocol;
      // Use /ws as the default WebSocket endpoint
      if (!parsed.pathname.includes('/ws')) {
        parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/ws';
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }
}

/**
 * Convert an AsyncGenerator to an AsyncIterable.
 */
async function* streamToAsyncIterable(stream: AsyncGenerator<StreamChunk>): AsyncIterable<StreamChunk> {
  for await (const chunk of stream) {
    yield chunk;
  }
}

/**
 * Factory function to create an OvolveAgentClient instance.
 */
export function createOvolveAgentClient(config: SdkConfig): OvolveAgentClient {
  return new OvolveAgentClient(config);
}
