/**
 * @oa/memory — Recall pipeline
 * 
 * Implements semantic recall with hybrid search:
 * 1. Keyword extraction from query
 * 2. Query embedding
 * 3. Hybrid search (0.7 vector + 0.3 FTS5)
 * 4. Decay weighting (half-life 30 days)
 * 5. MMR diversification (lambda 0.7)
 * 6. Drift markers (90d+ = drift warning)
 * 
 * Over-fetches 4x candidates, then re-ranks with MMR.
 */

import {
  MemoryEntry,
  MemoryTier,
  RecallOptions,
  RecallResult,
  RecallOutcome,
  DriftWarning,
  SearchCandidate,
} from './types';
import { Embedder, cosineSimilarity } from './embedder';
import { MemoryRepository } from './repository';
import { calculateDecayFactor, getTierPolicy } from './tiers';

/** Default configuration values */
const DEFAULTS = {
  RECALL_LIMIT: 10,
  OVER_FETCH_MULTIPLIER: 4,
  MMR_LAMBDA: 0.7,
  DRIFT_THRESHOLD_DAYS: 90,
  DECAY_HALF_LIFE_DAYS: 30,
  VECTOR_WEIGHT: 0.7,
  KEYWORD_WEIGHT: 0.3,
  MIN_SCORE: 0.1,
};

/**
 * Extract keywords from a query string.
 * Handles both English and Chinese text.
 */
export function extractKeywords(query: string): string[] {
  const keywords: string[] = [];

  // Extract English words (3+ chars)
  const englishWords = query.toLowerCase().match(/[a-z]{3,}/g) || [];
  keywords.push(...englishWords);

  // Extract Chinese character sequences (2+ chars)
  const chineseSeqs = query.match(/[\u4e00-\u9fff]{2,}/g) || [];
  keywords.push(...chineseSeqs);

  // Extract numbers that might be significant (versions, dates, etc.)
  const numbers = query.match(/\d+(?:\.\d+)?/g) || [];
  keywords.push(...numbers);

  // Deduplicate
  return [...new Set(keywords)];
}

/**
 * Calculate MMR (Maximal Marginal Relevance) score.
 * 
 * MMR = λ * relevance - (1 - λ) * max_similarity_to_selected
 * 
 * @param candidate - The candidate to score
 * @param selected - Already selected candidates
 * @param lambda - Diversity parameter (0 = max diversity, 1 = max relevance)
 */
function mmrScore(
  candidate: SearchCandidate,
  selected: SearchCandidate[],
  lambda: number
): number {
  if (selected.length === 0) {
    return candidate.hybridScore;
  }

  // Find maximum similarity to already selected items
  let maxSim = 0;
  for (const sel of selected) {
    const sim = cosineSimilarity(candidate.entry.embedding, sel.entry.embedding);
    if (sim > maxSim) maxSim = sim;
  }

  return lambda * candidate.hybridScore - (1 - lambda) * maxSim;
}

/**
 * Apply MMR diversification to candidates.
 */
function mmrRerank(
  candidates: SearchCandidate[],
  limit: number,
  lambda: number
): SearchCandidate[] {
  if (candidates.length <= limit) return candidates;

  const selected: SearchCandidate[] = [];
  const remaining = [...candidates];

  // Select first item (highest hybrid score)
  selected.push(remaining.shift()!);

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const score = mmrScore(remaining[i], selected, lambda);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

/**
 * Recall engine — orchestrates the full recall pipeline.
 */
export class RecallEngine {
  private embedder: Embedder;
  private repository: MemoryRepository;
  private config: {
    recallLimit: number;
    overFetchMultiplier: number;
    mmrLambda: number;
    driftThresholdDays: number;
    decayHalfLifeDays: number;
    vectorWeight: number;
    keywordWeight: number;
    minScore: number;
  };

  constructor(
    embedder: Embedder,
    repository: MemoryRepository,
    config: {
      recallLimit?: number;
      overFetchMultiplier?: number;
      mmrLambda?: number;
      driftThresholdDays?: number;
      decayHalfLifeDays?: number;
      vectorWeight?: number;
      keywordWeight?: number;
      minScore?: number;
    } = {}
  ) {
    this.embedder = embedder;
    this.repository = repository;
    this.config = {
      recallLimit: config.recallLimit ?? DEFAULTS.RECALL_LIMIT,
      overFetchMultiplier: config.overFetchMultiplier ?? DEFAULTS.OVER_FETCH_MULTIPLIER,
      mmrLambda: config.mmrLambda ?? DEFAULTS.MMR_LAMBDA,
      driftThresholdDays: config.driftThresholdDays ?? DEFAULTS.DRIFT_THRESHOLD_DAYS,
      decayHalfLifeDays: config.decayHalfLifeDays ?? DEFAULTS.DECAY_HALF_LIFE_DAYS,
      vectorWeight: config.vectorWeight ?? DEFAULTS.VECTOR_WEIGHT,
      keywordWeight: config.keywordWeight ?? DEFAULTS.KEYWORD_WEIGHT,
      minScore: config.minScore ?? DEFAULTS.MIN_SCORE,
    };
  }

  /**
   * Execute the full recall pipeline.
   */
  async recall(
    sessionId: string,
    query: string,
    options: RecallOptions = {}
  ): Promise<RecallOutcome> {
    const startTime = Date.now();
    const limit = options.limit ?? this.config.recallLimit;
    const overFetch = limit * (options.overFetchMultiplier ?? this.config.overFetchMultiplier);
    const mmrLambda = options.mmrLambda ?? this.config.mmrLambda;
    const driftThreshold = options.driftThresholdDays ?? this.config.driftThresholdDays;
    const decayWeight = options.decayWeight ?? 1.0;

    // Step 1: Extract keywords
    const keywords = extractKeywords(query);

    // Step 2: Embed the query
    const [queryEmbedding] = await this.embedder.embed([query]);

    // Step 3: Hybrid search
    const candidates = await this.hybridSearch(
      sessionId,
      queryEmbedding,
      keywords,
      overFetch,
      options.tiers
    );

    // Step 4: Apply decay weighting
    const now = Date.now();
    const decayedCandidates = candidates.map((c) => {
      const ageDays = (now - c.entry.createdAt) / (1000 * 60 * 60 * 24);
      const policy = getTierPolicy(c.entry.tier);
      const halfLife = policy.decayEnabled ? policy.decayHalfLifeDays : this.config.decayHalfLifeDays;
      const decayFactor = calculateDecayFactor(ageDays, halfLife);

      return {
        ...c,
        hybridScore: c.hybridScore * (1 - decayWeight + decayWeight * decayFactor),
        decayFactor,
        ageDays,
      };
    });

    // Step 5: MMR re-ranking
    const reranked = mmrRerank(decayedCandidates, limit, mmrLambda);

    // Step 6: Build results with drift warnings
    const results: RecallResult[] = [];
    const driftWarnings: DriftWarning[] = [];
    const promotions: string[] = [];

    for (const candidate of reranked) {
      const driftWarning = candidate.ageDays >= driftThreshold;

      if (driftWarning) {
        driftWarnings.push({
          entryId: candidate.entry.id,
          ageDays: Math.round(candidate.ageDays),
          message: `Memory is ${Math.round(candidate.ageDays)} days old — may be outdated`,
        });
      }

      results.push({
        entry: candidate.entry,
        score: candidate.hybridScore,
        vectorScore: candidate.vectorScore,
        keywordScore: candidate.keywordScore,
        hybridScore: candidate.hybridScore,
        decayFactor: candidate.decayFactor,
        ageDays: candidate.ageDays,
        driftWarning,
        promoted: false,
      });
    }

    // Track hits if requested
    if (options.trackHits !== false) {
      for (const result of results) {
        await this.repository.incrementHitCount(result.entry.id);
      }
    }

    return {
      results,
      totalCandidates: candidates.length,
      driftWarnings,
      promotions,
      queryEmbedding,
      keywords,
      elapsedMs: Date.now() - startTime,
    };
  }

  /**
   * Hybrid search combining vector similarity and FTS5 keyword matching.
   */
  private async hybridSearch(
    sessionId: string,
    queryEmbedding: Float32Array,
    keywords: string[],
    limit: number,
    tiers?: MemoryTier[]
  ): Promise<SearchCandidate[]> {
    // Get candidate memories
    const entries = await this.repository.getAllActive(tiers);

    // Calculate vector scores
    const candidates: SearchCandidate[] = entries.map((entry) => {
      const vectorScore = cosineSimilarity(queryEmbedding, entry.embedding);
      return {
        entry,
        vectorScore,
        keywordScore: 0,
        hybridScore: 0,
      };
    });

    // If we have keywords, do FTS5 search and combine
    if (keywords.length > 0) {
      const keywordQuery = keywords.join(' ');
      const ftsResults = await this.repository.searchByKeywords(keywordQuery, limit * 2);
      const ftsScores = new Map<string, number>();

      // Score based on FTS rank position
      ftsResults.forEach((entry, idx) => {
        const score = 1 - idx / (ftsResults.length + 1);
        ftsScores.set(entry.id, score);
      });

      // Combine scores
      for (const candidate of candidates) {
        const keywordScore = ftsScores.get(candidate.entry.id) ?? 0;
        candidate.keywordScore = keywordScore;
        candidate.hybridScore =
          this.config.vectorWeight * candidate.vectorScore +
          this.config.keywordWeight * keywordScore;
      }
    } else {
      // No keywords, use vector only
      for (const candidate of candidates) {
        candidate.hybridScore = candidate.vectorScore;
      }
    }

    // Filter by minimum score and sort
    return candidates
      .filter((c) => c.hybridScore >= this.config.minScore)
      .sort((a, b) => b.hybridScore - a.hybridScore)
      .slice(0, limit);
  }

  /**
   * Inject relevant memories into context.
   * Returns formatted context string and metadata.
   */
  async inject(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
    options: RecallOptions = {}
  ): Promise<{
    context: string;
    entries: MemoryEntry[];
    tokensUsed: number;
    tiersUsed: MemoryTier[];
  }> {
    // Build query from recent messages
    const recentMessages = messages.slice(-5);
    const query = recentMessages.map((m) => m.content).join(' ');

    const outcome = await this.recall(sessionId, query, options);

    // Group by tier and respect token budgets
    const tierGroups = new Map<MemoryTier, MemoryEntry[]>();
    const tiersUsed: MemoryTier[] = [];
    let tokensUsed = 0;
    const parts: string[] = [];

    for (const result of outcome.results) {
      const tier = result.entry.tier;
      const policy = getTierPolicy(tier);

      if (!tierGroups.has(tier)) {
        tierGroups.set(tier, []);
      }

      const group = tierGroups.get(tier)!;
      const currentTokens = group.reduce((sum, e) => sum + e.content.length, 0);

      if (currentTokens + result.entry.content.length <= policy.tokenBudget) {
        group.push(result.entry);
        if (!tiersUsed.includes(tier)) {
          tiersUsed.push(tier);
        }
        tokensUsed += result.entry.content.length;
      }
    }

    // Format context
    for (const [tier, entries] of tierGroups) {
      if (entries.length === 0) continue;
      parts.push(`[${tier}]`);
      for (const entry of entries) {
        parts.push(`- ${entry.content}`);
      }
    }

    // Add drift warnings if any
    if (outcome.driftWarnings.length > 0) {
      parts.push('[DRIFT WARNINGS]');
      for (const warning of outcome.driftWarnings) {
        parts.push(`- ${warning.message}`);
      }
    }

    return {
      context: parts.join('\n'),
      entries: outcome.results.map((r) => r.entry),
      tokensUsed,
      tiersUsed,
    };
  }
}
