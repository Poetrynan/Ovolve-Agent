/**
 * @oa/web — Web UI Components for OvolveAgent
 *
 * Provides React components and hooks for building web interfaces
 * that interact with OvolveAgent.
 */

export interface WebConfig {
  apiEndpoint?: string;
  wsEndpoint?: string;
  theme?: 'light' | 'dark' | 'auto';
  locale?: string;
}

export const DEFAULT_WEB_CONFIG: WebConfig = {
  apiEndpoint: 'http://localhost:5173',
  wsEndpoint: 'ws://localhost:5174',
  theme: 'auto',
  locale: 'en',
};

export interface WebSession {
  connect(config?: WebConfig): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

export class WebSessionImpl implements WebSession {
  private config: WebConfig;
  private connected: boolean = false;

  constructor(config: WebConfig = {}) {
    this.config = { ...DEFAULT_WEB_CONFIG, ...config };
  }

  async connect(config?: WebConfig): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export function createWebSession(config?: WebConfig): WebSession {
  return new WebSessionImpl(config);
}

// React hooks (stubs for actual implementation)
export function useAgentLoop(): {
  agentLoop: import('@oa/agent-loop').AgentLoop | null;
  isReady: boolean;
} {
  return {
    agentLoop: null,
    isReady: false,
  };
}

export function useSession(): {
  session: import('@oa/session-core').Session | null;
  isLoading: boolean;
} {
  return {
    session: null,
    isLoading: false,
  };
}

export { DEFAULT_WEB_CONFIG as defaultConfig };
