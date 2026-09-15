/**
 * Server-Sent Events (SSE) transport for MCP connections.
 *
 * Establishes an SSE connection to receive server messages,
 * and uses HTTP POST for sending client requests/responses.
 * This is the legacy MCP transport pattern.
 */

import { EventEmitter } from 'events';
import type { SseConfig } from '../types.js';

/** Pending request awaiting response */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * SseTransport implements the MCP SSE transport.
 * Uses EventSource (or fetch-based SSE) for server->client messages
 * and HTTP POST for client->server messages.
 */
export class SseTransport extends EventEmitter {
  private config: SseConfig;
  private eventSource: EventSource | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestId: number = 0;
  private connected: boolean = false;
  private endpointUrl: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private shutdownRequested: boolean = false;

  constructor(config: SseConfig) {
    super();
    this.config = config;
  }

  /** Whether the SSE connection is active */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Establish SSE connection to the server.
   * The server provides a POST endpoint via an 'endpoint' event.
   */
  async connect(): Promise<void> {
    this.shutdownRequested = false;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('SSE connection timeout'));
      }, 15000);

      try {
        this.eventSource = new EventSource(this.config.url, {
          withCredentials: true,
        });

        this.eventSource.onopen = () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          clearTimeout(timeout);
          this.emit('connected');
          resolve();
        };

        this.eventSource.onerror = (event) => {
          if (!this.connected) {
            clearTimeout(timeout);
            reject(new Error('SSE connection failed'));
            return;
          }
          this.handleConnectionLoss();
        };

        this.eventSource.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        // Listen for the endpoint event that gives us the POST URL
        this.eventSource.addEventListener('endpoint', (event: MessageEvent<string>) => {
          this.endpointUrl = (event as MessageEvent<string>).data;
          if (!this.endpointUrl?.startsWith('http')) {
            // Relative URL — resolve against the SSE endpoint
            const baseUrl = new URL(this.config.url);
            this.endpointUrl = new URL(this.endpointUrl, baseUrl.origin).toString();
          }
        });

        // Listen for standard MCP message events
        this.eventSource.addEventListener('message', (event: MessageEvent<string>) => {
          this.handleMessage((event as MessageEvent<string>).data);
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a JSON-RPC request via HTTP POST to the server-provided endpoint.
   */
  async request(method: string, params?: Record<string, unknown>, timeoutMs: number = 30000): Promise<unknown> {
    if (!this.connected) {
      throw new Error('Transport not connected');
    }

    if (!this.endpointUrl) {
      // Wait for endpoint to be available
      await this.waitForEndpoint(timeoutMs);
    }

    const id = String(++this.requestId);
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      fetch(this.endpointUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          const json = await response.json();
          this.handleJsonResponse(id, json);
        })
        .catch((err) => {
          const pending = this.pendingRequests.get(id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(id);
            pending.reject(err);
          }
        });
    });
  }

  /**
   * Send a JSON-RPC notification via HTTP POST.
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.connected || !this.endpointUrl) {
      throw new Error('Transport not connected or endpoint not available');
    }

    const body = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} });

    fetch(this.endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch((err) => {
      this.emit('error', err);
    });
  }

  /**
   * Disconnect the SSE connection.
   */
  async disconnect(): Promise<void> {
    this.shutdownRequested = true;
    this.connected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport disconnected'));
      this.pendingRequests.delete(id);
    }

    this.emit('disconnected');
  }

  /**
   * Handle incoming SSE message.
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

    if (message.id !== undefined) {
      const id = String(message.id);
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);

        if (message.error) {
          const err = message.error as { code: number; message: string };
          pending.reject(new Error(`RPC error ${err.code}: ${err.message}`));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.method) {
      this.emit('notification', message.method as string, message.params);
    }
  }

  /**
   * Handle JSON response from POST request.
   */
  private handleJsonResponse(id: string, json: Record<string, unknown>): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(id);

    if (json.error) {
      const err = json.error as { code: number; message: string };
      pending.reject(new Error(`RPC error ${err.code}: ${err.message}`));
    } else {
      pending.resolve(json.result);
    }
  }

  /**
   * Handle connection loss with automatic reconnection.
   */
  private handleConnectionLoss(): void {
    this.connected = false;
    this.emit('connection_lost');

    if (this.shutdownRequested) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }

    const interval = this.config.reconnectInterval ?? 3000;
    const delay = Math.min(interval * Math.pow(1.5, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // Reconnect failure handled by onerror
      }
    }, delay);
  }

  /**
   * Wait for the server to provide the POST endpoint.
   */
  private waitForEndpoint(timeoutMs: number): Promise<void> {
    if (this.endpointUrl) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Endpoint URL not received from server'));
      }, timeoutMs);

      const checkEndpoint = () => {
        if (this.endpointUrl) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkEndpoint, 100);
        }
      };
      checkEndpoint();
    });
  }
}

/**
 * Create a new SseTransport instance.
 */
export function createSseTransport(config: SseConfig): SseTransport {
  return new SseTransport(config);
}
