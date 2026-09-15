/**
 * @oa/compaction — Anti-Loop Guards
 *
 * Prevents runaway compaction loops through three mechanisms:
 * 1. Cooldown: Minimum time between auto-folds (default 15s).
 * 2. Max consecutive: Limit folds at the same layer before escalating.
 * 3. Incremental check: Skip if no new content since last fold.
 */

import type { FoldConfig, FoldGuard } from './types';
import { FoldLayer } from './types';

// ---------------------------------------------------------------------------
// Internal guard state store (per session)
// ---------------------------------------------------------------------------

const guardStore = new Map<string, FoldGuard>();

/**
 * Get or initialize the guard state for a session.
 */
export function getGuard(sessionId: string): FoldGuard {
  let guard = guardStore.get(sessionId);
  if (!guard) {
    guard = {
      lastFoldTimestamp: 0,
      consecutiveCount: 0,
      consecutiveLayer: FoldLayer.MICROFOLD,
      lastContentHash: '',
      totalFolds: 0,
      totalTokensSaved: 0,
    };
    guardStore.set(sessionId, guard);
  }
  return guard;
}

/**
 * Reset the guard state for a session.
 */
export function resetGuard(sessionId: string): void {
  guardStore.delete(sessionId);
}

/**
 * Remove guard state for a session (cleanup).
 */
export function removeGuard(sessionId: string): void {
  guardStore.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Guard checks
// ---------------------------------------------------------------------------

export interface GuardCheckResult {
  /** Whether folding is allowed. */
  allowed: boolean;
  /** Reason for blocking (if not allowed). */
  reason?: string;
  /** Recommended layer escalation (if consecutive limit reached). */
  escalateTo?: FoldLayer;
}

/**
 * Run all guard checks to determine if a fold should proceed.
 *
 * @param sessionId The session identifier.
 * @param config The fold configuration.
 * @param contentHash Hash of current content for incremental check.
 * @param requestedLayer The layer being requested.
 */
export function checkGuards(
  sessionId: string,
  config: FoldConfig,
  contentHash: string,
  requestedLayer: FoldLayer
): GuardCheckResult {
  const guard = getGuard(sessionId);
  const now = Date.now();

  // 1. Cooldown check — enforce minimum time between auto-folds
  const elapsed = now - guard.lastFoldTimestamp;
  if (guard.lastFoldTimestamp > 0 && elapsed < config.cooldownMs) {
    return {
      allowed: false,
      reason: `Cooldown active: ${Math.ceil((config.cooldownMs - elapsed) / 1000)}s remaining`,
    };
  }

  // 2. Incremental check — skip if no new content since last fold
  if (guard.lastContentHash !== '' && guard.lastContentHash === contentHash) {
    return {
      allowed: false,
      reason: 'No new content since last fold (incremental check)',
    };
  }

  // 3. Max consecutive check — escalate layer if too many at same level
  if (
    guard.consecutiveCount >= config.maxConsecutiveFolds &&
    guard.consecutiveLayer === requestedLayer
  ) {
    const nextLayer = Math.min(requestedLayer + 1, FoldLayer.TRUNCATION) as FoldLayer;
    if (nextLayer !== requestedLayer) {
      return {
        allowed: true,
        escalateTo: nextLayer,
        reason: `Consecutive limit (${config.maxConsecutiveFolds}) reached at layer ${FoldLayer[requestedLayer]}, escalating to ${FoldLayer[nextLayer]}`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Record a successful fold in the guard state.
 */
export function recordFold(
  sessionId: string,
  layer: FoldLayer,
  contentHash: string,
  tokensSaved: number
): void {
  const guard = getGuard(sessionId);
  const now = Date.now();

  guard.lastFoldTimestamp = now;
  guard.lastContentHash = contentHash;
  guard.totalFolds++;
  guard.totalTokensSaved += tokensSaved;

  // Track consecutive folds at the same layer
  if (guard.consecutiveLayer === layer) {
    guard.consecutiveCount++;
  } else {
    guard.consecutiveLayer = layer;
    guard.consecutiveCount = 1;
  }
}

/**
 * Record a layer escalation — resets consecutive counter.
 */
export function recordEscalation(
  sessionId: string,
  newLayer: FoldLayer
): void {
  const guard = getGuard(sessionId);
  guard.consecutiveLayer = newLayer;
  guard.consecutiveCount = 1;
}

/**
 * Compute a simple hash of message content for incremental comparison.
 * Uses a fast non-cyclic hash — not for security, just change detection.
 */
export function computeContentHash(messages: { content: string; role: string }[]): string {
  let hash = 0;
  const str = messages.map((m) => `${m.role}:${m.content}`).join('|');
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  // Mix in message count to catch additions/removals
  return `${messages.length}_${(hash >>> 0).toString(16)}`;
}

/**
 * Get all active guard states (for monitoring/debugging).
 */
export function getAllGuards(): Map<string, FoldGuard> {
  return new Map(guardStore);
}
