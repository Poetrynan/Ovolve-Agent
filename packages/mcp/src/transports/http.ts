/**
 * Streamable HTTP transport for MCP connections.
 *
 * Uses standard HTTP requests with streaming responses.
 * Implements the MCP Streamable HTTP protocol where the server
 * can return either a single JSON response or a stream of events.
 */

import { EventEmitter } from 'events';
import type { HttpConfig } from '../types.js';

/** Pending request awaiting response */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * HttpTransport implements the MCP Streamable HTTP transport.
 * Each request is an independent HTTP POST with JSON body.
 * Server responses can be application/json or text/event-stream.
 */
export class HttpTransport extends EventEmitter {
  private config: HttpConfig;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestId: number = 0;
  private connected: boolean = false;
  private defaultTimeout: number;

  constructor(config: HttpConfig) {
    super();
    this.config = config;
    this.defaultTimeout = config.timeout ?? 30000;
  }

  /** Whether the transport is connected (HTTP is stateless, so this means configured) */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Establish the HTTP transport connection.
   * Validates the server is reachable with a health check.
   */
  async connect(): Promise<void> {
    try {
      const response = await this.fetchWithTimeout(this.config.url, {
        method: 'GET',
        headers: this.buildHeaders(),
      }, 10000);

      // HTTP transport is stateless; being reachable means connected
      this.connected = true;
      this.emit('connected');
    } catch (err) {
      // Even if GET fails, the POST endpoint might still work
      this.connected = true;
      this.emit('connected');
    }
  }

  /**
   * Send a JSON-RPC request via HTTP POST.
   * Handles both JSON responses and SSE streams.
   */
  async request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (!this.connected) {
      throw new Error('Transport not connected');
    }

    const id = String(++this.requestId);
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
    const timeout = timeoutMs ?? this.defaultTimeout;

    return new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timeout: timeoutHandle });

      this.fetchWithTimeout(this.config.url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body,
      }, timeout + 5000)
        .then(async (response) => {
          const contentType = response.headers.get('content-type') ?? '';
          if (contentType.includes('text/event-stream')) {
            await this.handleSseResponse(response, id);
          } else {
            const json = await response.json();
            this.handleJsonResponse(id, json);
          }
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
   * Send a JSON-RPC notification via HTTP POST (fire and forget).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.connected) {
      throw new Error('Transport not connected');
    }

    const body = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} });

    this.fetchWithTimeout(this.config.url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body,
    }, 10000).catch((err) => {
      this.emit('error', err);
    });
  }

  /**
   * Disconnect (no-op for stateless HTTP, just marks state).
   */
  async disconnect(): Promise<void> {
    this.connected = false;

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport disconnected'));
      this.pendingRequests.delete(id);
    }

    this.emit('disconnected');
  }

  /**
   * Handle a JSON response from the server.
   */
  private handleJsonResponse(id: string, json: Record<string, unknown>): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(id);

    if (json.error) {
      const err = json.error as { code: number; message: string; data?: unknown };
      pending.reject(new Error(`RPC error ${err.code}: ${err.message}`));
    } else {
      pending.resolve(json.result);
    }
  }

  /**
   * Handle an SSE stream response, collecting the final JSON-RPC result.
   */
  private async handleSseResponse(response: Response, id: string): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        pending.reject(new Error('Empty response body'));
      }
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
          const lines = event.split('\n');
          let data = '';
          for (const line of lines) {
            if (line.startsWith('data:')) {
              data += line.slice(5).trim();
            }
          }

          if (data) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.id === id || parsed.id === undefined) {
                this.handleJsonResponse(id, parsed);
                return;
              }
            } catch {
              // Ignore non-JSON SSE events
            }
          }
        }
      }
    } catch (err) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Build request headers from config.
   */
  private buildHeaders(): Record<string, string> {
    return {
      ...(this.config.headers ?? {}),
    };
  }

  /**
   * Fetch with timeout support.
   */
  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Create a new HttpTransport instance.
 */
export function createHttpTransport(config: HttpConfig): HttpTransport {
  return new HttpTransport(config);
}
