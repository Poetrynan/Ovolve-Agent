/**
 * @oa/tui — Terminal UI for OvolveAgent
 *
 * Provides a terminal-based interface for interacting with OvolveAgent.
 */

export interface TuiConfig {
  systemPrompt?: string;
  model?: string;
  provider?: string;
  enableColors?: boolean;
  enableTimestamps?: boolean;
}

export const DEFAULT_TUI_CONFIG: TuiConfig = {
  enableColors: true,
  enableTimestamps: true,
};

export interface TuiSession {
  start(config?: TuiConfig): Promise<void>;
  stop(): Promise<void>;
  sendMessage(message: string): Promise<string>;
}

export class TuiSessionImpl implements TuiSession {
  private config: TuiConfig;
  private running: boolean = false;
  private agentLoop: import('@oa/agent-loop').AgentLoop | null = null;

  constructor(config: TuiConfig = {}) {
    this.config = { ...DEFAULT_TUI_CONFIG, ...config };
  }

  async start(config?: TuiConfig): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    this.running = true;
    console.log('TUI session started');
  }

  async stop(): Promise<void> {
    this.running = false;
    console.log('TUI session stopped');
  }

  async sendMessage(message: string): Promise<string> {
    if (!this.running) {
      throw new Error('TUI session is not running');
    }
    // In a real implementation, this would send to the agent loop
    return `Echo: ${message}`;
  }
}

export function createTuiSession(config?: TuiConfig): TuiSession {
  return new TuiSessionImpl(config);
}

export { DEFAULT_TUI_CONFIG as defaultConfig };
