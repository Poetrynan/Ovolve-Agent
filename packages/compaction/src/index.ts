/**
 * @oa/compaction — Public Exports
 *
 * 4-layer context compaction engine with anti-loop guards and quality audit.
 *
 * Layers (ordered by cost):
 * - Layer 0 (MICROFOLD):    Zero-cost stale tool result clearing
 * - Layer 1 (LLM_SUMMARY):  LLM-based structured summarization
 * - Layer 2 (HEURISTIC):    Rule-based importance extraction
 * - Layer 3 (TRUNCATION):   Hard truncation (last resort)
 *
 * @example
 * ```ts
 * import { createCompactionEngine, FoldLayer } from '@oa/compaction';
 *
 * const engine = createCompactionEngine({
 *   tokenThreshold: 6000,
 *   targetTokenCount: 3000,
 *   llmClient: myLlmClient,
 * });
 *
 * // Auto-fold with 4-layer degradation
 * const result = await engine.autoFold(sessionId, messages);
 *
 * // Manual fold with specific layer
 * const result = await engine.fold(sessionId, messages, {
 *   forceLayer: FoldLayer.HEURISTIC,
 * });
 * ```
 */

// Types
export {
  FoldLayer,
  type FoldConfig,
  type FoldResult,
  type FoldOptions,
  type FoldGuard,
  type FoldStats,
  type QualityAuditResult,
  type FoldEvent,
  type FoldSkippedEvent,
  type QualityAuditEvent,
  type CompactionMessage,
  DEFAULT_FOLD_CONFIG,
} from './types';

// Engine
export {
  CompactionEngine,
  createCompactionEngine,
  type CompactionEventType,
  type CompactionEvent,
  type CompactionEventHandler,
} from './compaction-engine';

// Guards
export {
  getGuard,
  resetGuard,
  removeGuard,
  checkGuards,
  computeContentHash,
  getAllGuards,
  type GuardCheckResult,
} from './guards';

// Quality audit
export {
  auditQuality,
  shouldAudit,
} from './quality-audit';

// Layer 0: Microfold
export {
  microfold,
  canMicrofold,
  type MicrofoldResult,
} from './layers/microfold';

// Layer 1: LLM Summary
export {
  llmSummaryFold,
  type LlmSummaryResult,
} from './layers/llm-summary';

// Layer 2: Heuristic
export {
  heuristicFold,
  type HeuristicResult,
} from './layers/heuristic';

// Layer 3: Truncation
export {
  truncateFold,
  type TruncationResult,
} from './layers/truncation';
