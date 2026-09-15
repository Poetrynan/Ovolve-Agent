/**
 * @oa/plugins — Memory Layer Plugin (built-in)
 *
 * Injects relevant memories into the LLM request context before each call.
 * Listens for POST_TOOL_USE events to learn from tool results and
 * POST_LLM_RESPONSE to capture conversation summaries.
 */

import {
  IPlugin,
  PluginManifest,
  HookPoint,
  HookRegistry,
  PluginContext,
  HookHandler,
  HealthStatus,
} from '../types';

/**
 * A single memory entry.
 */
export interface MemoryEntry {
  id: string;
  content: string;
  category: MemoryCategory;
  importance: number; // 0-1, higher = more important
  createdAt: Date;
  lastAccessedAt?: Date;
  accessCount: number;
  metadata?: Record<string, unknown>;
}

/**
 * Categories for organizing memories.
 */
export enum MemoryCategory {
  PREFERENCE = 'PREFERENCE',
  FACT = 'FACT',
  CONVERSATION = 'CONVERSATION',
  TOOL_USAGE = 'TOOL_USAGE',
  CONTEXT = 'CONTEXT',
}

/**
 * Configuration for the memory layer plugin.
 */
export interface MemoryLayerConfig {
  /** Maximum number of memories to inject per request. */
  maxMemoriesPerRequest: number;
  /** Maximum total character length of injected memories. */
  maxInjectionLength: number;
  /** Minimum importance threshold for injection. */
  minImportance: number;
  /** Whether to auto-extract memories from conversations. */
  autoExtract: number;
  /** Custom memory store implementation. */
  store?: MemoryStore;
}

/**
 * Storage interface for memories. Can be backed by file, database, or vector store.
 */
export interface MemoryStore {
  add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'accessCount'>): Promise<MemoryEntry>;
  search(query: string, limit: number): Promise<MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | undefined>;
  update(id: string, updates: Partial<MemoryEntry>): Promise<MemoryEntry | undefined>;
  delete(id: string): Promise<boolean>;
  list(category?: MemoryCategory): Promise<MemoryEntry[]>;
  clear(): Promise<void>;
}

/**
 * Payload for PRE_LLM_REQUEST hook.
 */
export interface LLMRequestPayload {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Injected memory context added to the request.
 */
export interface InjectedMemoryContext {
  memories: MemoryEntry[];
  injectionPoint: 'system' | 'user';
  totalLength: number;
}

/**
 * Simple in-memory store implementation for development/testing.
 */
export class InMemoryStore implements MemoryStore {
  private memories: Map<string, MemoryEntry> = new Map();

  async add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'accessCount'>): Promise<MemoryEntry> {
    const memory: MemoryEntry = {
      ...entry,
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      createdAt: new Date(),
      accessCount: 0,
    };
    this.memories.set(memory.id, memory);
    return memory;
  }

  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    const lowerQuery = query.toLowerCase();
    const results: Array<{ entry: MemoryEntry; score: number }> = [];

    for (const entry of this.memories.values()) {
      // Simple text matching score.
      const contentLower = entry.content.toLowerCase();
      let score = 0;

      const queryTerms = lowerQuery.split(/\s+/);
      for (const term of queryTerms) {
        if (contentLower.includes(term)) {
          score += 1;
        }
      }

      // Factor in importance and recency.
      score += entry.importance * 2;
      if (entry.lastAccessedAt) {
        const daysSinceAccess =
          (Date.now() - entry.lastAccessedAt.getTime()) / (1000 * 60 * 60 * 24);
        score += Math.max(0, 1 - daysSinceAccess / 30);
      }

      if (score > 0) {
        results.push({ entry, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.entry);
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    return this.memories.get(id);
  }

  async update(id: string, updates: Partial<MemoryEntry>): Promise<MemoryEntry | undefined> {
    const existing = this.memories.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...updates };
    this.memories.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.memories.delete(id);
  }

  async list(category?: MemoryCategory): Promise<MemoryEntry[]> {
    const entries = Array.from(this.memories.values());
    if (category) {
      return entries.filter((e) => e.category === category);
    }
    return entries;
  }

  async clear(): Promise<void> {
    this.memories.clear();
  }

  get size(): number {
    return this.memories.size;
  }
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: MemoryLayerConfig = {
  maxMemoriesPerRequest: 5,
  maxInjectionLength: 2000,
  minImportance: 0.3,
  autoExtract: 1,
};

/**
 * Memory layer plugin implementation.
 */
export class MemoryLayerPlugin implements IPlugin {
  readonly manifest: PluginManifest = {
    name: 'memory-layer',
    version: '1.0.0',
    description: 'Injects relevant memories into LLM request context',
    author: 'OvolveAgent',
    hookPoints: [HookPoint.PRE_LLM_REQUEST, HookPoint.POST_TOOL_USE, HookPoint.POST_LLM_RESPONSE],
    riskLevel: RiskLevel.LOW,
  };

  private config: MemoryLayerConfig;
  private store: MemoryStore;

  constructor(config: Partial<MemoryLayerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = this.config.store ?? new InMemoryStore();
  }

  /**
   * Register hooks with the plugin system.
   */
  register(registry: HookRegistry, _context: PluginContext): void {
    // Inject memories before LLM request.
    const preLLMHandler: HookHandler<LLMRequestPayload> = async (payload) => {
      return this.injectMemories(payload);
    };
    registry.on(HookPoint.PRE_LLM_REQUEST, preLLMHandler, 50);

    // Learn from tool results.
    const postToolHandler = async (payload: unknown) => {
      await this.learnFromToolResult(payload);
      return payload;
    };
    registry.on(HookPoint.POST_TOOL_USE, postToolHandler, 90);

    // Learn from LLM responses.
    const postLLMHandler = async (payload: unknown) => {
      await this.learnFromResponse(payload);
      return payload;
    };
    registry.on(HookPoint.POST_LLM_RESPONSE, postLLMHandler, 90);
  }

  /**
   * Inject relevant memories into the LLM request.
   */
  private async injectMemories(payload: LLMRequestPayload): Promise<LLMRequestPayload> {
    // Extract the last user message as the query context.
    const lastUserMessage = [...payload.messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMessage) return payload;

    // Search for relevant memories.
    const memories = await this.store.search(
      lastUserMessage.content,
      this.config.maxMemoriesPerRequest * 2 // Fetch extra for filtering
    );

    // Filter by importance threshold.
    const filteredMemories = memories
      .filter((m) => m.importance >= this.config.minImportance)
      .slice(0, this.config.maxMemoriesPerRequest);

    if (filteredMemories.length === 0) return payload;

    // Build the memory injection string.
    let injection = '## Relevant Context from Memory\n\n';
    let currentLength = injection.length;

    const includedMemories: MemoryEntry[] = [];
    for (const memory of filteredMemories) {
      const memoryText = `- [${memory.category}] ${memory.content}\n`;
      if (currentLength + memoryText.length > this.config.maxInjectionLength) {
        break;
      }
      injection += memoryText;
      currentLength += memoryText.length;
      includedMemories.push(memory);

      // Update access tracking.
      await this.store.update(memory.id, {
        lastAccessedAt: new Date(),
        accessCount: memory.accessCount + 1,
      });
    }

    // Inject as a system message.
    const systemMessageIndex = payload.messages.findIndex((m) => m.role === 'system');
    if (systemMessageIndex >= 0) {
      // Append to existing system message.
      const updatedMessages = [...payload.messages];
      updatedMessages[systemMessageIndex] = {
        ...updatedMessages[systemMessageIndex],
        content: updatedMessages[systemMessageIndex].content + '\n\n' + injection,
      };
      return { ...payload, messages: updatedMessages };
    } else {
      // Prepend new system message.
      return {
        ...payload,
        messages: [{ role: 'system', content: injection }, ...payload.messages],
      };
    }
  }

  /**
   * Learn from tool execution results.
   */
  private async learnFromToolResult(payload: unknown): Promise<void> {
    if (!this.config.autoExtract) return;

    // Extract tool result information.
    const result = payload as { toolName?: string; result?: unknown; args?: Record<string, unknown> };
    if (!result?.toolName) return;

    // Store tool usage pattern as a memory.
    const content = `Tool "${result.toolName}" was used${
      result.args ? ` with args: ${JSON.stringify(result.args)}` : ''
    }`;

    await this.store.add({
      content,
      category: MemoryCategory.TOOL_USAGE,
      importance: 0.4,
      metadata: { toolName: result.toolName },
    });
  }

  /**
   * Learn from LLM responses.
   */
  private async learnFromResponse(payload: unknown): Promise<void> {
    if (!this.config.autoExtract) return;

    const response = payload as { content?: string; role?: string };
    if (!response?.content) return;

    // Store a summary of the response.
    const summary =
      response.content.length > 200
        ? response.content.slice(0, 200) + '...'
        : response.content;

    await this.store.add({
      content: `LLM response: ${summary}`,
      category: MemoryCategory.CONVERSATION,
      importance: 0.3,
    });
  }

  /**
   * Add a memory directly.
   */
  async addMemory(
    content: string,
    category: MemoryCategory = MemoryCategory.CONTEXT,
    importance = 0.5
  ): Promise<MemoryEntry> {
    return this.store.add({ content, category, importance });
  }

  /**
   * Search memories.
   */
  async searchMemories(query: string, limit = 10): Promise<MemoryEntry[]> {
    return this.store.search(query, limit);
  }

  /**
   * List all memories.
   */
  async listMemories(category?: MemoryCategory): Promise<MemoryEntry[]> {
    return this.store.list(category);
  }

  /**
   * Delete a memory.
   */
  async deleteMemory(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  /**
   * Health check.
   */
  async onHealthCheck(): Promise<HealthStatus> {
    const memories = await this.store.list();
    return {
      healthy: true,
      message: `Memory store active with ${memories.length} entries`,
      details: { count: memories.length },
    };
  }
}

/**
 * Need to import RiskLevel for the manifest.
 */
import { RiskLevel } from '../types';

/**
 * Factory function to create a MemoryLayerPlugin.
 */
export function createMemoryLayerPlugin(config?: Partial<MemoryLayerConfig>): MemoryLayerPlugin {
  return new MemoryLayerPlugin(config);
}
