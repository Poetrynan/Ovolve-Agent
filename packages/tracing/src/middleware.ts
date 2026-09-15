/**
 * @oa/tracing — Express/IPC Middleware
 *
 * Automatic tracing middleware for HTTP requests and Electron IPC commands.
 * Wraps request handlers to create spans for each incoming request,
 * capturing timing, status codes, and error information.
 *
 * Supports:
 *   - Express-style middleware (req, res, next)
 *   - Electron IPC command wrapping
 *   - Custom request handlers
 */

import { v4 as uuid } from 'uuid';
import { AgentTracer } from './agent-tracer';
import type {
  TracingConfig,
  MiddlewareRequest,
  MiddlewareResponse,
  NextFunction,
} from './types';

// ---------------------------------------------------------------------------
// Express-style middleware types
// ---------------------------------------------------------------------------

export interface ExpressRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  sessionId?: string;
  [key: string]: unknown;
}

export interface ExpressResponse {
  statusCode: number;
  body?: unknown;
  end: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

export type ExpressMiddleware = (
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// IPC command types
// ---------------------------------------------------------------------------

export interface IPCCommandContext {
  /** Command name. */
  command: string;
  /** Command arguments. */
  args?: Record<string, unknown>;
  /** Session ID (if available). */
  sessionId?: string;
  /** Webview window label. */
  windowLabel?: string;
}

export type IPCCommandHandler<TArgs = unknown, TResult = unknown> = (
  ctx: IPCCommandContext,
  args: TArgs
) => Promise<TResult>;

// ---------------------------------------------------------------------------
// Middleware options
// ---------------------------------------------------------------------------

export interface MiddlewareOptions {
  /** Whether to trace request body (default: false for privacy). */
  traceBody: boolean;
  /** Whether to trace response body (default: false). */
  traceResponseBody: boolean;
  /** Custom session ID extractor. */
  extractSessionId?: (req: ExpressRequest) => string | undefined;
  /** Custom name extractor. */
  extractName?: (req: ExpressRequest) => string;
  /** Paths to exclude from tracing. */
  excludePaths: string[];
  /** Whether to trace errors only (default: false). */
  errorsOnly: boolean;
}

const DEFAULT_MIDDLEWARE_OPTIONS: MiddlewareOptions = {
  traceBody: false,
  traceResponseBody: false,
  excludePaths: ['/health', '/ready', '/metrics', '/favicon.ico'],
  errorsOnly: false,
};

// ---------------------------------------------------------------------------
// TracingMiddleware — Middleware factory
// ---------------------------------------------------------------------------

export class TracingMiddleware {
  private tracer: AgentTracer;
  private options: MiddlewareOptions;

  constructor(tracer: AgentTracer, options: Partial<MiddlewareOptions> = {}) {
    this.tracer = tracer;
    this.options = { ...DEFAULT_MIDDLEWARE_OPTIONS, ...options };
  }

  // -------------------------------------------------------------------------
  // Express-style middleware
  // -------------------------------------------------------------------------

  /**
   * Create an Express-style middleware function that traces each request.
   */
  express(): ExpressMiddleware {
    return (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
      // Skip excluded paths
      if (this.shouldExclude(req.url)) {
        next();
        return;
      }

      const requestId = uuid();
      const startTime = Date.now();
      const sessionId = this.extractSessionId(req);
      const spanName = this.extractName(req) ?? `${req.method} ${req.url}`;

      // Create middleware request context
      const middlewareReq: MiddlewareRequest = {
        requestId,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: this.options.traceBody ? req.body : undefined,
        sessionId,
        timestamp: startTime,
      };

      // Start a span for this request
      const spanResult = this.tracer.startToolCall(sessionId ?? 'anonymous', spanName, middlewareReq);

      // Hook into response end to finalize the span
      const originalEnd = res.end.bind(res);
      res.end = (...args: unknown[]): unknown => {
        const endTime = Date.now();
        const duration = endTime - startTime;

        const middlewareRes: MiddlewareResponse = {
          statusCode: res.statusCode,
          body: this.options.traceResponseBody ? res.body : undefined,
          duration,
        };

        // End the span with response data
        if (spanResult) {
          this.tracer.endToolCall(sessionId ?? 'anonymous', spanResult.correlationKey, {
            output: {
              statusCode: middlewareRes.statusCode,
              duration: middlewareRes.duration,
            },
            isError: res.statusCode >= 400,
            errorMessage: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : undefined,
            startTime,
          });
        }

        return originalEnd(...args);
      };

      // Call next middleware
      next();
    };
  }

  // -------------------------------------------------------------------------
  // IPC command wrapper
  // -------------------------------------------------------------------------

  /**
   * Wrap an IPC command handler with tracing.
   */
  wrapIPCCommand<TArgs = unknown, TResult = unknown>(
    commandName: string,
    handler: IPCCommandHandler<TArgs, TResult>
  ): IPCCommandHandler<TArgs, TResult> {
    return async (ctx: IPCCommandContext, args: TArgs): Promise<TResult> => {
      const startTime = Date.now();
      const sessionId = ctx.sessionId ?? 'ipc-anonymous';

      // Start a span for this command
      const spanResult = this.tracer.startToolCall(sessionId, `ipc:${commandName}`, {
        command: commandName,
        args: this.sanitizeArgs(args),
        windowLabel: ctx.windowLabel,
      });

      try {
        const result = await handler(ctx, args);
        const endTime = Date.now();

        // End the span with success
        if (spanResult) {
          this.tracer.endToolCall(sessionId, spanResult.correlationKey, {
            output: { success: true },
            startTime,
          });
        }

        return result;
      } catch (error) {
        const endTime = Date.now();

        // End the span with error
        if (spanResult) {
          this.tracer.endToolCall(sessionId, spanResult.correlationKey, {
            output: { success: false },
            isError: true,
            errorMessage: error instanceof Error ? error.message : String(error),
            startTime,
          });
        }

        throw error;
      }
    };
  }

  // -------------------------------------------------------------------------
  // Generic request handler wrapper
  // -------------------------------------------------------------------------

  /**
   * Wrap any async function with tracing.
   */
  wrapAsync<TArgs extends unknown[], TResult>(
    name: string,
    fn: (...args: TArgs) => Promise<TResult>,
    options: { sessionId?: string; extractInput?: (...args: TArgs) => unknown } = {}
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
      const startTime = Date.now();
      const sessionId = options.sessionId ?? 'anonymous';

      const spanResult = this.tracer.startToolCall(sessionId, name, {
        input: options.extractInput ? options.extractInput(...args) : undefined,
      });

      try {
        const result = await fn(...args);

        if (spanResult) {
          this.tracer.endToolCall(sessionId, spanResult.correlationKey, {
            output: { success: true },
            startTime,
          });
        }

        return result;
      } catch (error) {
        if (spanResult) {
          this.tracer.endToolCall(sessionId, spanResult.correlationKey, {
            isError: true,
            errorMessage: error instanceof Error ? error.message : String(error),
            startTime,
          });
        }

        throw error;
      }
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private shouldExclude(url: string): boolean {
    return this.options.excludePaths.some(
      (path) => url === path || url.startsWith(path)
    );
  }

  private extractSessionId(req: ExpressRequest): string | undefined {
    if (this.options.extractSessionId) {
      return this.options.extractSessionId(req);
    }
    // Default: extract from header or query param
    const headerSid = req.headers['x-session-id'];
    if (headerSid) return Array.isArray(headerSid) ? headerSid[0] : headerSid;
    const urlParams = new URL(req.url, 'http://localhost').searchParams;
    return urlParams.get('sessionId') ?? undefined;
  }

  private extractName(req: ExpressRequest): string | undefined {
    if (this.options.extractName) {
      return this.options.extractName(req);
    }
    return undefined;
  }

  private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const sensitiveKeys = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];

    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveKeys.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  private sanitizeArgs(args: unknown): unknown {
    if (typeof args !== 'object' || args === null) return args;

    const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'api_key', 'authorization'];
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (sensitiveKeys.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create a tracing middleware instance.
 */
export function createMiddleware(
  tracer: AgentTracer,
  options: Partial<MiddlewareOptions> = {}
): TracingMiddleware {
  return new TracingMiddleware(tracer, options);
}

/**
 * Create an Express-style middleware directly from a tracer.
 */
export function createExpressMiddleware(
  tracer: AgentTracer,
  options: Partial<MiddlewareOptions> = {}
): ExpressMiddleware {
  const middleware = new TracingMiddleware(tracer, options);
  return middleware.express();
}
