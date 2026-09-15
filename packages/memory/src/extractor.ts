/**
 * @oa/memory — Memory extraction
 * 
 * Extracts memories from conversation messages:
 * - Debounced extraction (60s)
 * - LLM-based refinement (when available)
 * - Heuristic fallback (when LLM unavailable)
 * - Self-excitation guard (prevents extraction loops)
 */

import {
  MemoryEntry,
  MemoryType,
  MemoryScope,
  MemoryTier,
  ExtractOptions,
  ExtractOutcome,
  MemoryLink,
} from './types';
import { Embedder } from './embedder';
import { MemoryRepository } from './repository';

/** Message format for extraction */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Raw extraction before processing */
interface RawExtraction {
  content: string;
  type: MemoryType;
  importance: number;
  keywords: string[];
}

/** Self-excitation guard state */
interface ExcitationState {
  lastExtractionCount: number;
  consecutiveExtractions: number;
  lastExtractionTime: number;
}

/** Default configuration */
const DEFAULTS = {
  DEBOUNCE_MS: 60000, // 60 seconds
  MIN_IMPORTANCE: 0.3,
  MAX_CONSECUTIVE_EXTRACTIONS: 3,
  SELF_EXCITATION_COOLDOWN_MS: 120000, // 2 minutes
  MAX_EXTRACTIONS_PER_SESSION: 50,
};

/**
 * Generate a UUID v4.
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Heuristic extraction — extracts memories without LLM.
 * Uses pattern matching and rule-based classification.
 */
function heuristicExtract(messages: Message[]): RawExtraction[] {
  const extractions: RawExtraction[] = [];
  const now = Date.now();

  for (const message of messages) {
    if (message.role !== 'user') continue;

    const content = message.content;

    // Pattern: "I prefer/like/want/need"
    const preferenceMatch = content.match(
      /(?:i\s+(?:prefer|like|want|need|love|hate|dislike|always|never))\s+(.+?)(?:\.|$)/i
    );
    if (preferenceMatch) {
      extractions.push({
        content: preferenceMatch[1].trim(),
        type: MemoryType.PREFERENCE,
        importance: 0.7,
        keywords: extractKeywordsFromText(preferenceMatch[1]),
      });
    }

    // Pattern: "My name is/I am/I'm"
    const identityMatch = content.match(
      /(?:my\s+name\s+is|i\s+am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i
    );
    if (identityMatch) {
      extractions.push({
        content: `User name: ${identityMatch[1].trim()}`,
        type: MemoryType.IDENTITY,
        importance: 0.9,
        keywords: [identityMatch[1].trim().toLowerCase()],
      });
    }

    // Pattern: "Remember that/to"
    const rememberMatch = content.match(
      /(?:remember\s+(?:that|to))\s+(.+?)(?:\.|$)/i
    );
    if (rememberMatch) {
      extractions.push({
        content: rememberMatch[1].trim(),
        type: MemoryType.FACT,
        importance: 0.8,
        keywords: extractKeywordsFromText(rememberMatch[1]),
      });
    }

    // Pattern: Project-related statements
    const projectMatch = content.match(
      /(?:project|working\s+on|building|developing|creating)\s+(.+?)(?:\.|$)/i
    );
    if (projectMatch) {
      extractions.push({
        content: `Project: ${projectMatch[1].trim()}`,
        type: MemoryType.PROJECT,
        importance: 0.75,
        keywords: extractKeywordsFromText(projectMatch[1]),
      });
    }

    // Pattern: Task/todo items
    const taskMatch = content.match(
      /(?:todo|task|need\s+to|should|must|have\s+to)\s+(.+?)(?:\.|$)/i
    );
    if (taskMatch) {
      extractions.push({
        content: `Task: ${taskMatch[1].trim()}`,
        type: MemoryType.TASK,
        importance: 0.65,
        keywords: extractKeywordsFromText(taskMatch[1]),
      });
    }

    // Pattern: Facts with "is/are/was/were"
    const factMatch = content.match(
      /([A-Z][^.!?\n]{10,80}?)\s+(?:is|are|was|were)\s+([^.!?\n]{5,80})/i
    );
    if (factMatch) {
      extractions.push({
        content: `${factMatch[1].trim()} is ${factMatch[2].trim()}`,
        type: MemoryType.FACT,
        importance: 0.6,
        keywords: extractKeywordsFromText(factMatch[0]),
      });
    }
  }

  return extractions;
}

/**
 * Extract keywords from text for indexing.
 */
function extractKeywordsFromText(text: string): string[] {
  const keywords: string[] = [];

  // English words (3+ chars)
  const englishWords = text.toLowerCase().match(/[a-z]{3,}/g) || [];
  keywords.push(...englishWords);

  // Chinese sequences (2+ chars)
  const chineseSeqs = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  keywords.push(...chineseSeqs);

  return [...new Set(keywords)].slice(0, 20);
}

/**
 * Build LLM prompt for memory extraction.
 */
function buildExtractionPrompt(messages: Message[]): string {
  const conversation = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n');

  return `Extract memorable information from this conversation.
Return JSON array of extractions. Each extraction should have:
- content: concise statement of the memory
- type: one of CONVERSATION, PREFERENCE, FACT, PROJECT, IDENTITY, TASK
- importance: 0.0 to 1.0
- keywords: array of search terms

Only extract information worth remembering. Skip trivial or temporary details.

Conversation:
${conversation}

JSON response:`;
}

/**
 * Parse LLM extraction response.
 */
function parseLLMResponse(response: string): RawExtraction[] {
  try {
    // Try to find JSON array in response
    const jsonMatch = response.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item: any) => item.content && item.type)
      .map((item: any) => ({
        content: String(item.content),
        type: item.type as MemoryType,
        importance: typeof item.importance === 'number' ? item.importance : 0.5,
        keywords: Array.isArray(item.keywords) ? item.keywords : [],
      }));
  } catch {
    return [];
  }
}

/**
 * Deduplicate extractions against existing memories.
 */
async function deduplicate(
  extractions: RawExtraction[],
  repository: MemoryRepository,
  sessionId: string,
  embedder: Embedder
): Promise<RawExtraction[]> {
  const existing = await repository.getBySession(sessionId);
  if (existing.length === 0) return extractions;

  const existingEmbeddings = existing.map((e) => e.embedding);
  const unique: RawExtraction[] = [];

  for (const extraction of extractions) {
    const [embedding] = await embedder.embed([extraction.content]);

    // Check similarity against existing memories
    let isDuplicate = false;
    for (const existingEmb of existingEmbeddings) {
      let dot = 0;
      for (let i = 0; i < embedding.length; i++) {
        dot += embedding[i] * existingEmb[i];
      }
      if (dot > 0.9) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      unique.push(extraction);
    }
  }

  return unique;
}

/**
 * Memory extractor — extracts and stores memories from conversations.
 */
export class MemoryExtractor {
  private embedder: Embedder;
  private repository: MemoryRepository;
  private config: {
    debounceMs: number;
    minImportance: number;
    maxConsecutiveExtractions: number;
    selfExcitationCooldownMs: number;
    maxExtractionsPerSession: number;
    llmRefine?: (prompt: string) => Promise<string>;
  };

  private excitationStates: Map<string, ExcitationState> = new Map();
  private lastExtractionTime: Map<string, number> = new Map();

  constructor(
    embedder: Embedder,
    repository: MemoryRepository,
    config: {
      debounceMs?: number;
      minImportance?: number;
      maxConsecutiveExtractions?: number;
      selfExcitationCooldownMs?: number;
      maxExtractionsPerSession?: number;
      llmRefine?: (prompt: string) => Promise<string>;
    } = {}
  ) {
    this.embedder = embedder;
    this.repository = repository;
    this.config = {
      debounceMs: config.debounceMs ?? DEFAULTS.DEBOUNCE_MS,
      minImportance: config.minImportance ?? DEFAULTS.MIN_IMPORTANCE,
      maxConsecutiveExtractions: config.maxConsecutiveExtractions ?? DEFAULTS.MAX_CONSECUTIVE_EXTRACTIONS,
      selfExcitationCooldownMs: config.selfExcitationCooldownMs ?? DEFAULTS.SELF_EXCITATION_COOLDOWN_MS,
      maxExtractionsPerSession: config.maxExtractionsPerSession ?? DEFAULTS.MAX_EXTRACTIONS_PER_SESSION,
      llmRefine: config.llmRefine,
    };
  }

  /**
   * Extract memories from conversation messages.
   */
  async extract(
    sessionId: string,
    messages: Message[],
    options: ExtractOptions = {}
  ): Promise<ExtractOutcome> {
    const startTime = Date.now();
    const minImportance = options.minImportance ?? this.config.minImportance;

    // Check debounce
    const lastTime = this.lastExtractionTime.get(sessionId) ?? 0;
    if (Date.now() - lastTime < this.config.debounceMs) {
      return {
        created: [],
        links: [],
        rawCount: 0,
        dedupedCount: 0,
        elapsedMs: Date.now() - startTime,
      };
    }

    // Check self-excitation guard
    if (this.isSelfExciting(sessionId)) {
      return {
        created: [],
        links: [],
        rawCount: 0,
        dedupedCount: 0,
        elapsedMs: Date.now() - startTime,
      };
    }

    // Get raw extractions
    let rawExtractions: RawExtraction[];

    if (options.useLLM !== false && this.config.llmRefine) {
      // LLM-based extraction
      const prompt = buildExtractionPrompt(messages);
      try {
        const response = await this.config.llmRefine(prompt);
        rawExtractions = parseLLMResponse(response);
      } catch {
        // Fallback to heuristic on LLM failure
        rawExtractions = heuristicExtract(messages);
      }
    } else {
      // Heuristic extraction
      rawExtractions = heuristicExtract(messages);
    }

    const rawCount = rawExtractions.length;

    // Filter by importance and type
    const filtered = rawExtractions.filter(
      (e) =>
        e.importance >= minImportance &&
        (!options.types || options.types.includes(e.type))
    );

    // Deduplicate
    const deduped = await deduplicate(filtered, this.repository, sessionId, this.embedder);

    // Create memory entries
    const created: MemoryEntry[] = [];
    const now = Date.now();

    for (const extraction of deduped) {
      const [embedding] = await this.embedder.embed([extraction.content]);

      const entry = await this.repository.insert({
        tier: MemoryTier.SHORT_TERM_RECALL,
        type: extraction.type,
        scope: MemoryScope.SESSION,
        sessionId,
        content: extraction.content,
        embedding,
        keywords: extraction.keywords,
        importance: extraction.importance,
        hitCount: 0,
        createdAt: now,
        accessedAt: now,
        expiresAt: now + 12 * 60 * 60 * 1000, // 12h TTL
        source: 'extraction',
        archived: false,
        metadata: {},
      });

      created.push(entry);
    }

    // Create links if requested
    const links: MemoryLink[] = [];
    if (options.createLinks !== false && created.length > 1) {
      for (let i = 0; i < created.length - 1; i++) {
        for (let j = i + 1; j < created.length; j++) {
          const link = await this.repository.createLink(
            created[i].id,
            created[j].id,
            'co-occurred',
            0.5
          );
          links.push(link);
        }
      }
    }

    // Update excitation state
    this.updateExcitationState(sessionId, created.length);
    this.lastExtractionTime.set(sessionId, Date.now());

    return {
      created,
      links,
      rawCount,
      dedupedCount: deduped.length,
      elapsedMs: Date.now() - startTime,
    };
  }

  /**
   * Check if extraction is self-exciting (looping).
   */
  private isSelfExciting(sessionId: string): boolean {
    const state = this.excitationStates.get(sessionId);
    if (!state) return false;

    // If too many consecutive extractions with many results, cool down
    if (
      state.consecutiveExtractions >= this.config.maxConsecutiveExtractions &&
      Date.now() - state.lastExtractionTime < this.config.selfExcitationCooldownMs
    ) {
      return true;
    }

    return false;
  }

  /**
   * Update self-excitation tracking state.
   */
  private updateExcitationState(sessionId: string, extractionCount: number): void {
    const state = this.excitationStates.get(sessionId) ?? {
      lastExtractionCount: 0,
      consecutiveExtractions: 0,
      lastExtractionTime: 0,
    };

    if (extractionCount > 0) {
      state.consecutiveExtractions =
        state.lastExtractionCount > 0
          ? state.consecutiveExtractions + 1
          : 1;
    } else {
      state.consecutiveExtractions = 0;
    }

    state.lastExtractionCount = extractionCount;
    state.lastExtractionTime = Date.now();

    this.excitationStates.set(sessionId, state);
  }

  /**
   * Reset extraction state for a session.
   */
  resetSession(sessionId: string): void {
    this.excitationStates.delete(sessionId);
    this.lastExtractionTime.delete(sessionId);
  }
}
