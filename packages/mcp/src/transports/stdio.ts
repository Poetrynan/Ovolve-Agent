/**
 * Stdio transport for MCP connections.
 *
 * Spawns a subprocess and communicates via stdin/stdout using
 * the MCP JSON-RPC protocol over newline-delimited messages.
 */

import { EventEmitter } from 'events';
import type { StdioConfig, McpToolResult } from '../types.js';

/** Pending request awaiting response */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * StdioTransport implements the MCP stdio transport.
 * Spawns a child process and exchanges JSON-RPC messages via stdin/stdout.
 */
export class StdioTransport extends EventEmitter {
  private process: ReturnType<typeof import('child_process').spawn> | null = null;
  private config: StdioConfig;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private buffer: string = '';
  private requestId: number = 0;
  private connected: boolean = false;
  private shutdownRequested: boolean = false;

  constructor(config: StdioConfig) {
    super();
    this.config = config;
  }

  /** Whether the transport is currently connected */
  isConnected(): boolean {
    return this.connected && this.process !== null;
  }

  /**
   * Start the subprocess and establish communication.
   * Resolves when the process has spawned successfully.
   */
  async connect(): Promise<void> {
    const { spawn } = await import('child_process');

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...this.config.env,
    };

    this.process = spawn(this.config.command, this.config.args ?? [], {
      env,
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout!.setEncoding('utf-8');
    this.process.stdout!.on('data', (data: string) => this.handleStdout(data));

    this.process.stderr!.setEncoding('utf-8');
    this.process.stderr!.on('data', (data: string) => {
      this.emit('stderr', data);
    });

    this.process.on('error', (err: Error) => {
      this.handleError(new Error(`Process error: ${err.message}`));
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      this.handleDisconnect(code, signal);
    });

    this.connected = true;
    this.emit('connected');
  }

  /**
   * Send a JSON-RPC request and await the response.
   * @param method - RPC method name
   * @param params - RPC parameters
   * @param timeoutMs - Request timeout in milliseconds
   */
  async request(method: string, params?: Record<string, unknown>, timeoutMs: number = 30000): Promise<unknown> {
    if (!this.connected || !this.process) {
      throw new Error('Transport not connected');
    }

    const id = String(++this.requestId);
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.process!.stdin!.write(message + '\n');
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.connected || !this.process) {
      throw new Error('Transport not connected');
    }

    const message = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} });
    this.process.stdin!.write(message + '\n');
  }

  /**
   * Disconnect and terminate the subprocess.
   */
  async disconnect(): Promise<void> {
    this.shutdownRequested = true;
    this.connected = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport disconnected'));
      this.pendingRequests.delete(id);
    }

    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');

      // Force kill after 5 seconds if still alive
      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.process!.on('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      });
    }

    this.process = null;
    this.emit('disconnected');
  }

  /**
   * Handle incoming stdout data (newline-delimited JSON-RPC).
   */
  private handleStdout(data: string): void {
    this.buffer += data;
    let newlineIndex: number;

    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line) {
        this.processMessage(line);
      }
    }
  }

  /**
   * Process a single JSON-RPC message.
   */
  private processMessage(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit('parse_error', line);
      return;
    }

    const message = parsed as Record<string, unknown>;

    // Response (has id)
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

    // Notification (no id)
    if (message.method) {
      this.emit('notification', message.method as string, message.params);
    }
  }

  /**
   * Handle process error.
   */
  private handleError(error: Error): void {
    this.connected = false;
    this.emit('error', error);
  }

  /**
   * Handle process disconnect/exit.
   */
  private handleDisconnect(code: number | null, signal: string | null): void {
    this.connected = false;
    if (!this.shutdownRequested) {
      this.emit('unexpected_exit', { code, signal });
    }
    this.emit('disconnected');
  }
}

/**
 * Create a new StdioTransport instance.
 */
export function createStdioTransport(config: StdioConfig): StdioTransport {
  return new StdioTransport(config);
}
