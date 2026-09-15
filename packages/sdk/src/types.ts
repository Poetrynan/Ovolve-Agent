/**
 * @oa/sdk — OvolveAgent TypeScript SDK types
 *
 * Type definitions for the public SDK that connects to OvolveAgent
 * via WebSocket (streaming) and REST (query) interfaces.
 */

/** SDK operation modes */
export type SdkMode = 'interactive' | 'print' | 'json' | 'rpc';

/** SDK configuration */
export interface SdkConfig {
  /** Server URL (WebSocket or HTTP) */
  serverUrl: string;
  /** Authentication token */
  authToken?: string;
  /** API key for authentication */
  apiKey?: string;
  /** Default operation mode */
  mode?: SdkMode;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** WebSocket reconnection enabled */
  reconnectEnabled?: boolean;
  /** Maximum reconnection attempts */
  maxReconnectAttempts?: number;
  /** Custom headers */
  headers?: Record<string, string>;
  /** TLS/SSL configuration */
  tls?: {
    enabled: boolean;
    certPath?: string;
    keyPath?: string;
    caPath?: string;
    rejectUnauthorized?: boolean;
  };
}

/** Session creation options */
export interface CreateSessionOptions {
  /** Initial system prompt */
  systemPrompt?: string;
  /** Model to use */
  model?: string;
  /** Temperature setting */
  temperature?: number;
  /** Maximum tokens */
  maxTokens?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Tags for categorization */
  tags?: string[];
  /** Parent session ID (for forks) */
  parentSessionId?: string;
}

/** Chat message options */
export interface ChatOptions {
  /** Stream the response */
  stream?: boolean;
  /** Temperature override */
  temperature?: number;
  /** Max tokens override */
  maxTokens?: number;
  /** Tool configurations */
  tools?: Array<{
    name: string;
    enabled: boolean;
  }>;
  /** Additional context */
  context?: Record<string, unknown>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/** Chat message (user input) */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

/** Tool call in a message */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Session information */
export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'paused' | 'stopped' | 'archived';
  model?: string;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  messageCount: number;
  parentSessionId?: string;
  forkPoint?: number;
}

/** Stream event types */
export type StreamEventType =
  | 'message_start'
  | 'message_delta'
  | 'message_stop'
  | 'content_start'
  | 'content_delta'
  | 'content_stop'
  | 'tool_call_start'
  | 'tool_call_delta'
  | 'tool_call_stop'
  | 'error'
  | 'done';

/** Stream event from WebSocket */
export interface StreamEvent {
  type: StreamEventType;
  sessionId: string;
  data: Record<string, unknown>;
  timestamp: number;
}

/** Content delta event */
export interface ContentDeltaEvent extends StreamEvent {
  type: 'content_delta';
  data: {
    contentId: string;
    delta: string;
    index: number;
  };
}

/** Tool call event */
export interface ToolCallEvent extends StreamEvent {
  type: 'tool_call_start' | 'tool_call_delta' | 'tool_call_stop';
  data: {
    toolCallId: string;
    toolName: string;
    arguments?: string;
    result?: string;
  };
}

/** Error event */
export interface ErrorEvent extends StreamEvent {
  type: 'error';
  data: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Event query options */
export interface EventQueryOptions {
  /** Event types to filter */
  types?: StreamEventType[];
  /** Starting timestamp */
  after?: number;
  /** Ending timestamp */
  before?: number;
  /** Maximum number of events */
  limit?: number;
  /** Pagination cursor */
  cursor?: string;
}

/** Session state */
export interface SessionState {
  sessionId: string;
  status: 'idle' | 'thinking' | 'executing' | 'waiting' | 'complete' | 'error';
  currentTurn: number;
  activeTool?: string;
  context: {
    tokenCount: number;
    maxTokens: number;
  };
  lastUpdate: number;
}

/** Search options */
export interface SearchOptions {
  /** Event types to search */
  types?: StreamEventType[];
  /** Maximum results */
  limit?: number;
  /** Case sensitive */
  caseSensitive?: boolean;
  /** Use regex */
  regex?: boolean;
}

/** Search result */
export interface SearchResult {
  sessionId: string;
  events: StreamEvent[];
  totalCount: number;
  query: string;
}

/** Fork session options */
export interface ForkSessionOptions {
  /** Source session ID */
  sourceId: string;
  /** Event index to fork at */
  forkPoint: number;
  /** Override system prompt */
  systemPrompt?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** List sessions filter */
export interface ListSessionsFilter {
  /** Filter by status */
  status?: Session['status'][];
  /** Filter by tags */
  tags?: string[];
  /** Filter by model */
  model?: string;
  /** Filter by creation date */
  createdAfter?: number;
  createdBefore?: number;
  /** Pagination */
  limit?: number;
  offset?: number;
}

/** Paginated response */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** API response wrapper */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** WebSocket connection state */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

/** WebSocket message types */
export type WsMessageType =
  | 'subscribe'
  | 'unsubscribe'
  | 'chat'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'ping'
  | 'pong';

/** WebSocket outgoing message */
export interface WsOutgoingMessage {
  type: WsMessageType;
  id: string;
  payload: Record<string, unknown>;
}

/** WebSocket incoming message */
export interface WsIncomingMessage {
  type: WsMessageType | StreamEventType | 'error' | 'ack';
  id?: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

/** SDK client statistics */
export interface ClientStats {
  sessionsCreated: number;
  messagesSent: number;
  messagesReceived: number;
  toolCalls: number;
  errors: number;
  uptime: number;
  reconnects: number;
}
