/**
 * REST API client for OvolveAgent SDK.
 *
 * Provides CRUD operations for sessions, event queries, and state queries
 * via standard HTTP requests.
 */

import type {
  SdkConfig,
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
  ApiResponse,
} from './types.js';

/** Default request timeout in milliseconds */
const DEFAULT_TIMEOUT = 30000;

/**
 * RESTClient provides HTTP-based access to OvolveAgent's API.
 *
 * Use this for:
 * - Session CRUD operations
 * - Event history queries
 * - State queries
 * - Non-streaming interactions
 */
export class RESTClient {
  private baseUrl: string;
  private authToken?: string;
  private apiKey?: string;
  private customHeaders: Record<string, string>;
  private timeout: number;

  constructor(config: SdkConfig) {
    this.baseUrl = config.serverUrl.replace(/\/+$/, '');
    this.authToken = config.authToken;
    this.apiKey = config.apiKey;
    this.customHeaders = config.headers ?? {};
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
  }

  // ==================== Session Operations ====================

  /**
   * Create a new session.
   */
  async createSession(options?: CreateSessionOptions): Promise<Session> {
    return this.request<Session>('POST', '/api/v1/sessions', options);
  }

  /**
   * Get a session by ID.
   */
  async getSession(sessionId: string): Promise<Session> {
    return this.request<Session>('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  /**
   * List sessions with optional filters.
   */
  async listSessions(filter?: ListSessionsFilter): Promise<PaginatedResponse<Session>> {
    const params = new URLSearchParams();

    if (filter?.status) {
      params.set('status', filter.status.join(','));
    }
    if (filter?.tags) {
      params.set('tags', filter.tags.join(','));
    }
    if (filter?.model) {
      params.set('model', filter.model);
    }
    if (filter?.createdAfter) {
      params.set('created_after', String(filter.createdAfter));
    }
    if (filter?.createdBefore) {
      params.set('created_before', String(filter.createdBefore));
    }
    if (filter?.limit) {
      params.set('limit', String(filter.limit));
    }
    if (filter?.offset) {
      params.set('offset', String(filter.offset));
    }

    const queryString = params.toString();
    return this.request<PaginatedResponse<Session>>(
      'GET',
      `/api/v1/sessions${queryString ? `?${queryString}` : ''}`,
    );
  }

  /**
   * Update a session.
   */
  async updateSession(
    sessionId: string,
    updates: Partial<Pick<Session, 'systemPrompt' | 'metadata' | 'tags' | 'status'>>,
  ): Promise<Session> {
    return this.request<Session>('PATCH', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, updates);
  }

  /**
   * Delete a session.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  /**
   * Fork a session at a specific point.
   */
  async forkSession(options: ForkSessionOptions): Promise<Session> {
    return this.request<Session>('POST', '/api/v1/sessions/fork', options);
  }

  // ==================== Chat Operations ====================

  /**
   * Send a message to a session (non-streaming).
   */
  async chat(sessionId: string, message: string, options?: ChatOptions): Promise<ChatMessage> {
    return this.request<ChatMessage>('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/chat`, {
      message,
      ...options,
    });
  }

  /**
   * Send multiple messages to a session.
   */
  async chatBatch(sessionId: string, messages: ChatMessage[], options?: ChatOptions): Promise<ChatMessage[]> {
    return this.request<ChatMessage[]>('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/chat/batch`, {
      messages,
      ...options,
    });
  }

  // ==================== Event Operations ====================

  /**
   * Get events for a session.
   */
  async getEvents(sessionId: string, options?: EventQueryOptions): Promise<PaginatedResponse<StreamEvent>> {
    const params = new URLSearchParams();

    if (options?.types) {
      params.set('types', options.types.join(','));
    }
    if (options?.after) {
      params.set('after', String(options.after));
    }
    if (options?.before) {
      params.set('before', String(options.before));
    }
    if (options?.limit) {
      params.set('limit', String(options.limit));
    }
    if (options?.cursor) {
      params.set('cursor', options.cursor);
    }

    const queryString = params.toString();
    return this.request<PaginatedResponse<StreamEvent>>(
      'GET',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/events${queryString ? `?${queryString}` : ''}`,
    );
  }

  /**
   * Search events within a session.
   */
  async searchEvents(sessionId: string, query: string, options?: {
    types?: string[];
    limit?: number;
    caseSensitive?: boolean;
    regex?: boolean;
  }): Promise<SearchResult> {
    return this.request<SearchResult>('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/search`, {
      query,
      ...options,
    });
  }

  // ==================== State Operations ====================

  /**
   * Get the current state of a session.
   */
  async getState(sessionId: string): Promise<SessionState> {
    return this.request<SessionState>('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/state`);
  }

  /**
   * Pause a session's current turn.
   */
  async pause(sessionId: string): Promise<SessionState> {
    return this.request<SessionState>('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/pause`);
  }

  /**
   * Resume a paused session.
   */
  async resume(sessionId: string): Promise<SessionState> {
    return this.request<SessionState>('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/resume`);
  }

  /**
   * Stop a session's current turn.
   */
  async stop(sessionId: string): Promise<SessionState> {
    return this.request<SessionState>('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/stop`);
  }

  // ==================== Utility Operations ====================

  /**
   * Health check.
   */
  async health(): Promise<{ status: string; version: string; uptime: number }> {
    return this.request<{ status: string; version: string; uptime: number }>('GET', '/api/v1/health');
  }

  /**
   * Get server info.
   */
  async getServerInfo(): Promise<{ name: string; version: string; capabilities: string[] }> {
    return this.request<{ name: string; version: string; capabilities: string[] }>('GET', '/api/v1/info');
  }

  // ==================== HTTP Helper ====================

  /**
   * Make an HTTP request to the API.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.customHeaders,
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        try {
          const errorJson = JSON.parse(errorBody) as ApiResponse<unknown>;
          if (errorJson.error) {
            errorMessage = errorJson.error.message;
          }
        } catch {
          // Use default error message
        }
        throw new Error(errorMessage);
      }

      // Handle empty responses
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        return undefined as T;
      }

      const result = await response.json() as ApiResponse<T> | T;

      // Unwrap API response if needed
      if (result && typeof result === 'object' && 'success' in result) {
        const apiResult = result as ApiResponse<T>;
        if (!apiResult.success && apiResult.error) {
          throw new Error(apiResult.error.message);
        }
        return apiResult.data as T;
      }

      return result as T;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timeout: ${method} ${path} (${this.timeout}ms)`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
