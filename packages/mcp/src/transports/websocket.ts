/**
 * WebSocket transport for MCP connections.
 *
 * Establishes a persistent WebSocket connection for bidirectional
 * JSON-RPC communication with MCP servers.
 */

import { EventEmitter } from 'events';
import type { WebSocketConfig } from '../types.js';

/** Pending request awaiting response */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * WebSocketTransport implements the MCP WebSocket transport.
 * Provides full-duplex communication over a single WebSocket connection.
 */
export class WebSocketTransport extends EventEmitter {
  private config: WebSocketConfig;
  private socket: WebSocket | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestId: number = 0;
  private connected: boolean = false;
  private shutdownRequested: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffIntervals: number[] = [1000, 2000, 4000, 8000, 15000, 30000];

  constructor(config: WebSocketConfig) {
    super();
    this.config = config;
  }

  /** Whether the WebSocket is connected */
  isConnected(): boolean {
    return this.connected && this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Establish WebSocket connection to the MCP server.
   */
  async connect(): Promise<void> {
    this.shutdownRequested = false;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 15000);

      try {
        this.socket = new WebSocket(this.config.url, this.config.protocols);

        this.socket.onopen = () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          clearTimeout(timeout);
          this.emit('connected');
          resolve();
        };

        this.socket.onmessage = (event: MessageEvent) => {
          this.handleMessage(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
        };

        this.socket.onerror = (event: Event) => {
          if (!this.connected) {
            clearTimeout(timeout);
            reject(new Error('WebSocket connection failed'));
          } else {
            this.emit('error', new Error('WebSocket error'));
          }
        };

        this.socket.onclose = (event: CloseEvent) => {
          this.connected = false;
          this.emit('close', event.code, event.reason);

          if (!this.shutdownRequested) {
            this.handleReconnect();
          }
        };
      } catch (err) {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a JSON-RPC request over WebSocket and await the response.
   */
  async request(method: string, params?: Record<string, unknown>, timeoutMs: number = 30000): Promise<unknown> {
    if (!this.isConnected()) {
      throw new Error('WebSocket not connected');
    }

    const id = String(++this.requestId);
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.socket!.send(message);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.isConnected()) {
      throw new Error('WebSocket not connected');
    }

    const message = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} });
    this.socket!.send(message);
  }

  /**
   * Disconnect the WebSocket.
   */
  async disconnect(): Promise<void> {
    this.shutdownRequested = true;
    this.connected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport disconnected'));
      this.pendingRequests.delete(id);
    }

    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close(1000, 'Client disconnect');
      }
      this.socket = null;
    }

    this.emit('disconnected');
  }

  /**
   * Handle incoming WebSocket message.
   */
  private handleMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.emit('parse_error', data);
      return;
    }

    const message = parsed as Record<string, unknown>;

    // Response (has id field)
    if (message.id !== undefined) {
      const id = String(message.id);
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);

        if (message.error) {
          const err = message.error as { code: number; message: string; data?: unknown };
          pending.reject(new Error(`RPC error ${err.code}: ${err.message}`));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // Server notification (has method, no id)
    if (message.method) {
      this.emit('notification', message.method as string, message.params);
    }
  }

  /**
   * Handle reconnection with exponential backoff.
   */
  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }

    const delay = this.backoffIntervals[Math.min(this.reconnectAttempts, this.backoffIntervals.length - 1)];
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // Reconnect failure triggers another attempt via onclose
      }
    }, delay);
  }
}

/**
 * Create a new WebSocketTransport instance.
 */
export function createWebSocketTransport(config: WebSocketConfig): WebSocketTransport {
  return new WebSocketTransport(config);
}
