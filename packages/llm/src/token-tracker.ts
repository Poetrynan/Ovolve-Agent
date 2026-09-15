/**
 * Token usage tracking and cost calculation.
 *
 * Maintains cumulative usage per session / turn and computes estimated cost
 * based on per-model pricing.
 */

import type { TokenUsage, ModelConfig } from './types.js';

export interface TurnUsage {
  turnId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cost: number;
  duration: number;
  model: string;
  providerId: string;
  timestamp: number;
}

export interface SessionUsage {
  sessionTotal: TokenUsage;
  turns: TurnUsage[];
}

export interface TokenTrackerOptions {
  /** Called whenever a turn completes with final usage. */
  onTurnComplete?: (usage: TurnUsage) => void;
  /** Called when a session's cumulative usage is updated. */
  onSessionUpdate?: (usage: SessionUsage) => void;
}

/**
 * Create a fresh zeroed TokenUsage object.
 */
export function zeroUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cost: 0,
    duration: 0,
  };
}

/**
 * Add two TokenUsage objects together (returns a new object).
 */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cost: a.cost + b.cost,
    duration: a.duration + b.duration,
  };
}

/**
 * Compute the cost for a single LLM call given model pricing and token counts.
 */
export function computeCost(
  model: ModelConfig,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number = 0,
): number {
  // Cached tokens are typically cheaper (Anthropic charges 10% of input price).
  const uncachedPromptTokens = promptTokens - cachedTokens;
  const cachedCost = (cachedTokens / 1_000_000) * model.costPer1mTokens.input * 0.1;
  const promptCost = (uncachedPromptTokens / 1_000_000) * model.costPer1mTokens.input;
  const completionCost = (completionTokens / 1_000_000) * model.costPer1mTokens.output;

  return promptCost + completionCost + cachedCost;
}

/**
 * TokenTracker manages per-session and per-turn usage tracking.
 */
export class TokenTracker {
  private sessions = new Map<string, SessionUsage>();
  private options: TokenTrackerOptions;

  constructor(options: TokenTrackerOptions = {}) {
    this.options = options;
  }

  /**
   * Get or create a session's usage record.
   */
  getSession(sessionId: string): SessionUsage {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { sessionTotal: zeroUsage(), turns: [] };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Record a completed turn's usage.
   */
  recordTurn(
    sessionId: string,
    turnId: string,
    model: ModelConfig,
    providerId: string,
    promptTokens: number,
    completionTokens: number,
    cachedTokens: number = 0,
    duration: number = 0,
  ): TurnUsage {
    const cost = computeCost(model, promptTokens, completionTokens, cachedTokens);

    const turn: TurnUsage = {
      turnId,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cachedTokens,
      cost,
      duration,
      model: model.id,
      providerId,
      timestamp: Date.now(),
    };

    const session = this.getSession(sessionId);
    session.turns.push(turn);
    session.sessionTotal = addUsage(session.sessionTotal, {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cachedTokens,
      cost,
      duration,
    });

    this.options.onTurnComplete?.(turn);
    this.options.onSessionUpdate?.(session);

    return turn;
  }

  /**
   * Get cumulative usage for a session.
   */
  getSessionTotal(sessionId: string): TokenUsage {
    return this.getSession(sessionId).sessionTotal;
  }

  /**
   * Get all turns for a session.
   */
  getTurns(sessionId: string): TurnUsage[] {
    return this.getSession(sessionId).turns;
  }

  /**
   * Reset a session's tracking data.
   */
  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Remove all session data.
   */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Get total cost across all sessions.
   */
  getGlobalCost(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      total += session.sessionTotal.cost;
    }
    return total;
  }
}
