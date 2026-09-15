/**
 * Context assembler for building LLM requests from session state.
 *
 * Assembles the system prompt (6 layers), projects message history,
 * injects memory and skill metadata, and provides tool definitions.
 */

import type {
  LlmRequest,
  LlmMessage,
  ToolDefinition,
  SessionState,
  SystemPromptLayer,
  ContextAssemblyResult,
  MemoryItem,
  SkillMetadata,
  AgentEvent,
  ThinkingLevel,
} from './types.js';

export interface ContextAssemblerConfig {
  /** Base system prompt. */
  systemPrompt: string;
  /** Additional system prompt layers. */
  promptLayers: SystemPromptLayer[];
  /** Whether to inject memory. */
  enableMemoryInjection: boolean;
  /** Whether to inject skill metadata. */
  enableSkillInjection: boolean;
  /** Memory provider function. */
  getMemory?: (sessionId: string) => MemoryItem[] | Promise<MemoryItem[]>;
  /** Skill provider function. */
  getSkills?: (sessionId: string) => SkillMetadata[] | Promise<SkillMetadata[]>;
  /** Available tool definitions. */
  toolDefs: ToolDefinition[];
  /** Maximum context window size in tokens. */
  maxContextTokens: number;
  /** Event handler. */
  onEvent?: (event: AgentEvent) => void;
}

/**
 * Default system prompt layers (6 layers as per design).
 */
const DEFAULT_LAYERS: SystemPromptLayer[] = [
  {
    id: 'identity',
    priority: 0,
    content: 'You are OvolveAgent, a capable AI assistant running locally on the user\'s machine.',
  },
  {
    id: 'capabilities',
    priority: 10,
    content:
      'You have access to tools that can read/write files, execute commands, search the web, and interact with the user\'s system. Always confirm before destructive operations.',
  },
  {
    id: 'behavior',
    priority: 20,
    content:
      'Be concise and direct. When using tools, explain what you\'re doing. If you need clarification, ask. Prefer action over hedging.',
  },
  {
    id: 'safety',
    priority: 30,
    content:
      'Never execute commands that could harm the system without explicit user approval. Respect user privacy. Do not exfiltrate data.',
  },
  {
    id: 'format',
    priority: 40,
    content:
      'When you have completed the task, provide a clear summary. Use markdown for formatting when appropriate.',
  },
  {
    id: 'context_awareness',
    priority: 50,
    content:
      'You operate in a multi-step agent loop. Each step you can use tools or respond directly. Plan your approach before using tools.',
  },
];

/**
 * Assemble the full system prompt from layers.
 */
function assembleSystemPrompt(
  basePrompt: string,
  layers: SystemPromptLayer[],
  overrides?: string,
): string {
  if (overrides) return overrides;

  // Sort layers by priority.
  const sortedLayers = [...layers].sort((a, b) => a.priority - b.priority);

  const parts: string[] = [basePrompt];

  for (const layer of sortedLayers) {
    if (layer.content.trim()) {
      parts.push(layer.content);
    }
  }

  return parts.join('\n\n');
}

/**
 * Inject memory items into the system prompt.
 */
function injectMemory(systemPrompt: string, memory: MemoryItem[]): string {
  if (memory.length === 0) return systemPrompt;

  // Sort by relevance (highest first).
  const sorted = [...memory].sort((a, b) => b.relevance - a.relevance);

  const memorySection = sorted
    .map((item) => `- [${item.type}] ${item.content}`)
    .join('\n');

  return `${systemPrompt}\n\n## Memory\nThe following contextual information has been recalled:\n${memorySection}`;
}

/**
 * Inject skill metadata into the system prompt.
 */
function injectSkills(systemPrompt: string, skills: SkillMetadata[]): string {
  if (skills.length === 0) return systemPrompt;

  const skillSection = skills
    .map((skill) => {
      let s = `- **${skill.name}**: ${skill.description}`;
      if (skill.instructions) s += `\n  Instructions: ${skill.instructions}`;
      return s;
    })
    .join('\n');

  return `${systemPrompt}\n\n## Active Skills\nThe following skills are available:\n${skillSection}`;
}

/**
 * Project message history to fit within context limits.
 * Trims oldest messages if needed, preserving system and most recent.
 */
function projectMessageHistory(
  messages: LlmMessage[],
  maxTokens: number,
): LlmMessage[] {
  // Simple estimation: 1 token ≈ 4 characters.
  const estimateTokens = (msg: LlmMessage): number => {
    if (typeof msg.content === 'string') {
      return Math.ceil(msg.content.length / 4);
    }
    return msg.content.reduce((sum, block) => {
      if (block.type === 'text') return sum + Math.ceil(block.text.length / 4);
      return sum + 100; // Rough estimate for non-text blocks;
    }, 0);
  };

  let totalTokens = messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);

  if (totalTokens <= maxTokens) return messages;

  // Keep system messages and trim from the middle.
  const result: LlmMessage[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateTokens(msg);

    // Always keep system messages.
    if (msg.role === 'system') {
      result.push(msg);
      currentTokens += msgTokens;
      continue;
    }

    // Skip if we're over budget (keep most recent).
    if (currentTokens + msgTokens > maxTokens * 0.7) {
      continue;
    }

    result.push(msg);
    currentTokens += msgTokens;
  }

  return result;
}

/**
 * Build the LLM request from session state.
 */
export async function assembleContext(
  session: SessionState,
  config: ContextAssemblerConfig,
  options: {
    model: string;
    temperature: number;
    maxTokens: number;
    thinking?: ThinkingLevel;
    systemPromptOverride?: string;
    toolFilter?: string[];
  },
): Promise<ContextAssemblyResult> {
  // 1. Assemble system prompt from layers.
  let systemPrompt = assembleSystemPrompt(
    config.systemPrompt,
    config.promptLayers.length > 0 ? config.promptLayers : DEFAULT_LAYERS,
    options.systemPromptOverride,
  );

  // 2. Inject memory if enabled.
  if (config.enableMemoryInjection && config.getMemory) {
    const memory = await config.getMemory(session.id);
    systemPrompt = injectMemory(systemPrompt, memory);
  }

  // 3. Inject skill metadata if enabled.
  if (config.enableSkillInjection && config.getSkills) {
    const skills = await config.getSkills(session.id);
    systemPrompt = injectSkills(systemPrompt, skills);
  }

  // 4. Project message history.
  const projectedMessages = projectMessageHistory(
    session.messages,
    config.maxContextTokens,
  );

  // 5. Filter tools if specified.
  let tools = config.toolDefs;
  if (options.toolFilter && options.toolFilter.length > 0) {
    tools = tools.filter((t) => options.toolFilter!.includes(t.function.name));
  }

  // 6. Build the LLM request.
  const systemMessage: LlmMessage = {
    role: 'system',
    content: systemPrompt,
  };

  const request: LlmRequest = {
    messages: [systemMessage, ...projectedMessages.filter((m) => m.role !== 'system')],
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    tools: tools.length > 0 ? tools : undefined,
    toolChoice: tools.length > 0 ? 'auto' : undefined,
    thinking: options.thinking,
    metadata: {
      sessionId: session.id,
      step: session.currentStep,
    },
  };

  config.onEvent?.({
    type: 'agent:context_assembled',
    sessionId: session.id,
    timestamp: Date.now(),
    data: { request },
  });

  return {
    systemPrompt,
    messages: request.messages,
    tools,
    metadata: {
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      thinking: options.thinking,
      messageCount: request.messages.length,
      toolCount: tools.length,
    },
  };
}

/**
 * Create a context assembler with default config.
 */
export function createContextAssembler(
  config: Partial<ContextAssemblerConfig> & { systemPrompt: string; toolDefs: ToolDefinition[] },
): ContextAssemblerConfig {
  return {
    promptLayers: DEFAULT_LAYERS,
    enableMemoryInjection: true,
    enableSkillInjection: true,
    maxContextTokens: 100_000,
    ...config,
  };
}
