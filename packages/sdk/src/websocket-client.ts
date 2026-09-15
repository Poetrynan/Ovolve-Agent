/**
 * WebSocket client for OvolveAgent SDK.
 *
 * Provides real-time event streaming with:
 * - Auto-reconnect with exponential backoff [1,2,4,8,15,30]s
 * - Event streaming and subscription management
 * - Connection state management
 * - Heartbeat/ping-pong keepalive
 */

import { EventEmitter } from 'events';
import type {
  ConnectionState,
  StreamEvent,
  WsOutgoingMessage,
  WsIncomingMessage,
} from './types.js';

/** Reconnection backoff intervals in milliseconds */
const BACKOFF_INTERVALS = [1000, 2000, 4000, 8000, 15000, 30000];

/** Heartbeat interval in milliseconds */
const HEARTBEAT_INTERVAL = 30000;

/** Heartbeat timeout in milliseconds */
const HEARTBEAT_TIMEOUT = 10000;

/**
 * WebSocketClient manages the WebSocket connection to OvolveAgent.
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Event subscription management
 * - Connection state tracking
 * - Message queuing during disconnection
 */
export class WebSocketClient extends EventEmitter {
  private url: string;
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectEnabled: boolean;
  private maxReconnectAttempts: number;
  private reconnectAttempts: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private messageQueue: WsOutgoingMessage[] = [];
  private subscriptions: Set<string> = new Set();
  private messageId: number = 0;
  private pendingMessages: Map<string, {
    resolve: (response: WsIncomingMessage) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();
  private authToken?: string;
  private apiKey?: string;
  private customHeaders: Record<string, string>;

  constructor(url: string, options?: {
    reconnectEnabled?: boolean;
    maxReconnectAttempts?: number;
    authToken?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  }) {
    super();
    this.url = url;
    this.reconnectEnabled = options?.reconnectEnabled ?? true;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 6;
    this.authToken = options?.authToken;
    this.apiKey = options?.apiKey;
    this.customHeaders = options?.headers ?? {};
  }

  /** Get the current connection state */
  getState(): ConnectionState {
    return this.state;
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.state === 'connected' && this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to the OvolveAgent WebSocket server.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.setState('connecting');
    this.emit('connecting');

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.state !== 'connected') {
          this.setState('failed');
          reject(new Error('WebSocket connection timeout'));
        }
      }, 15000);

      try {
        // Build URL with auth params if needed
        const wsUrl = this.buildConnectionUrl();
        this.socket = new WebSocket(wsUrl);

        this.socket.onopen = () => {
          this.setState('connected');
          this.reconnectAttempts = 0;
          clearTimeout(timeout);
          this.startHeartbeat();
          this.flushMessageQueue();
          this.resubscribeAll();
          this.emit('connected');
          resolve();
        };

        this.socket.onmessage = (event: MessageEvent) => {
          this.handleMessage(
            typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data),
          );
        };

        this.socket.onerror = () => {
          if (this.state !== 'connected') {
            clearTimeout(timeout);
            this.setState('failed');
            reject(new Error('WebSocket connection failed'));
          } else {
            this.emit('error', new Error('WebSocket error'));
          }
        };

        this.socket.onclose = (event: CloseEvent) => {
          const wasConnected = this.state === 'connected';
          this.setState('disconnected');
          this.stopHeartbeat();
          this.emit('disconnected', event.code, event.reason);

          if (wasConnected && this.reconnectEnabled) {
            this.handleReconnect();
          }
        };
      } catch (err) {
        clearTimeout(timeout);
        this.setState('failed');
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    this.reconnectEnabled = false;
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending messages
    for (const [id, pending] of this.pendingMessages) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Disconnected'));
      this.pendingMessages.delete(id);
    }

    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close(1000, 'Client disconnect');
      }
      this.socket = null;
    }

    this.setState('disconnected');
  }

  /**
   * Send a message and await a response.
   */
  async sendAndWait(message: Omit<WsOutgoingMessage, 'id'>, timeoutMs: number = 30000): Promise<WsIncomingMessage> {
    const id = this.generateMessageId();
    const fullMessage: WsOutgoingMessage = { ...message, id };

    return new Promise<WsIncomingMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMessages.delete(id);
        reject(new Error(`Message timeout: ${message.type} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingMessages.set(id, { resolve, reject, timeout });
      this.send(fullMessage);
    });
  }

  /**
   * Send a message (fire and forget).
   */
  send(message: Omit<WsOutgoingMessage, 'id'> | WsOutgoingMessage): void {
    const fullMessage = 'id' in message ? message : { ...message, id: this.generateMessageId() };

    if (this.isConnected()) {
      this.socket!.send(JSON.stringify(fullMessage));
    } else {
      // Queue message for when connection is restored
      this.messageQueue.push(fullMessage);
      this.emit('message_queued', fullMessage);
    }
  }

  /**
   * Subscribe to events for a session.
   */
  subscribe(sessionId: string): void {
    this.subscriptions.add(sessionId);
    this.send({
      type: 'subscribe',
      payload: { sessionId },
    });
  }

  /**
   * Unsubscribe from events for a session.
   */
  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    this.send({
      type: 'unsubscribe',
      payload: { sessionId },
    });
  }

  /**
   * Get all active subscriptions.
   */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions);
  }

  /**
   * Build the WebSocket connection URL with auth parameters.
   */
  private buildConnectionUrl(): string {
    try {
      const url = new URL(this.url);

      if (this.authToken) {
        url.searchParams.set('token', this.authToken);
      }

      if (this.apiKey) {
        url.searchParams.set('api_key', this.apiKey);
      }

      return url.toString();
    } catch {
      return this.url;
    }
  }

  /**
   * Handle incoming WebSocket message.
   */
  private handleMessage(data: string): void {
    let parsed: WsIncomingMessage;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.emit('parse_error', data);
      return;
    }

    // Handle heartbeat pong
    if (parsed.type === 'pong') {
      if (this.heartbeatTimeoutHandle) {
        clearTimeout(this.heartbeatTimeoutHandle);
        this.heartbeatTimeoutHandle = null;
      }
      return;
    }

    // Handle ack/response to pending messages
    if (parsed.id && this.pendingMessages.has(parsed.id)) {
      const pending = this.pendingMessages.get(parsed.id)!;
      clearTimeout(pending.timeout);
      this.pendingMessages.delete(parsed.id);
      pending.resolve(parsed);
      return;
    }

    // Handle stream events
    if (this.isStreamEventType(parsed.type)) {
      const event = parsed as unknown as StreamEvent;
      this.emit('stream_event', event);
      this.emit(`event:${event.type}`, event);

      if (event.data && typeof event.data === 'object' && 'sessionId' in event.data) {
        this.emit(`session:${(event.data as Record<string, unknown>).sessionId}`, event);
      }
      return;
    }

    // Handle errors
    if (parsed.type === 'error') {
      this.emit('server_error', parsed.payload);
      return;
    }

    // Generic message event
    this.emit('message', parsed);
  }

  /**
   * Check if a message type is a stream event type.
   */
  private isStreamEventType(type: string): boolean {
    const streamTypes = [
      'message_start', 'message_delta', 'message_stop',
      'content_start', 'content_delta', 'content_stop',
      'tool_call_start', 'tool_call_delta', 'tool_call_stop',
      'error', 'done',
    ];
    return streamTypes.includes(type);
  }

  /**
   * Handle reconnection with exponential backoff.
   */
  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('reconnect_failed');
      this.setState('failed');
      return;
    }

    this.setState('reconnecting');
    const delay = BACKOFF_INTERVALS[Math.min(this.reconnectAttempts, BACKOFF_INTERVALS.length - 1)];
    this.reconnectAttempts++;

    this.emit('reconnecting', this.reconnectAttempts, delay);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.emit('reconnected');
      } catch {
        // Reconnect failure triggers another attempt via onclose
      }
    }, delay);
  }

  /**
   * Start the heartbeat interval.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendPing();
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Stop the heartbeat.
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
   * Send a ping and set up timeout.
   */
  private sendPing(): void {
    if (!this.isConnected()) return;

    this.heartbeatTimeoutHandle = setTimeout(() => {
      // Ping timed out — connection is dead
      this.socket?.close(4000, 'Heartbeat timeout');
    }, HEARTBEAT_TIMEOUT);

    this.send({ type: 'ping', payload: {} });
  }

  /**
   * Flush queued messages after reconnection.
   */
  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0 && this.isConnected()) {
      const message = this.messageQueue.shift()!;
      this.socket!.send(JSON.stringify(message));
    }
  }

  /**
   * Resubscribe to all previously subscribed sessions.
   */
  private resubscribeAll(): void {
    for (const sessionId of this.subscriptions) {
      this.send({
        type: 'subscribe',
        payload: { sessionId },
      });
    }
  }

  /**
   * Transition to a new connection state.
   */
  private setState(newState: ConnectionState): void {
    const oldState = this.state;
    this.state = newState;
    this.emit('state_change', oldState, newState);
  }

  /**
   * Generate a unique message ID.
   */
  private generateMessageId(): string {
    return `msg_${++this.messageId}_${Date.now().toString(36)}`;
  }
}
