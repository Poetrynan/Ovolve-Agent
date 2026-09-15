/**
 * @oa/evolution — Public Exports
 *
 * Self-improvement evolution engine with signal mining and proposal system.
 *
 * Modes:
 * - OFF: No evolution activity (default)
 * - CAUTIOUS: Record signals, generate proposals, require approval
 * - ACTIVE: Record signals, generate proposals, auto-apply safe changes
 *
 * @example
 * ```ts
 * import { createEvolutionEngine, EvolutionMode } from '@oa/evolution';
 *
 * const engine = createEvolutionEngine({
 *   mode: EvolutionMode.CAUTIOUS,
 * });
 *
 * // Record a failure signal
 * engine.record({
 *   kind: 'tool_failure',
 *   toolName: 'file_write',
 *   rawMessage: 'Permission denied: /etc/config.yaml',
 *   sessionId: 'sess_123',
 * });
 *
 * // Mine for proposals
 * const proposals = engine.mine();
 *
 * // Decide on a proposal
 * engine.decide(proposals[0].id, true);
 * ```
 */

// Types
export {
  EvolutionMode,
  SignalKind,
  ProposalStatus,
  ProposalRisk,
  type Signal,
  type Proposal,
  type ModePolicy,
  type EvolutionConfig,
  type EvolutionEvent,
  DEFAULT_EVOLUTION_CONFIG,
  DEFAULT_MODE_POLICIES,
} from './types';

// Engine
export {
  EvolutionEngine,
  createEvolutionEngine,
  type EvolutionEventHandler,
} from './evolution-engine';

// Normalizer
export {
  normalizeSignal,
  normalizeSignalDetailed,
  containsSensitivePatterns,
  extractVariableParts,
} from './normalizer';

// Signature
export {
  generateSignature,
  generateSignatureFromObject,
  signaturesMatch,
  computeMessageSimilarity,
  addToCluster,
  getCluster,
  getClustersWithMinCount,
  getAllClusters,
  removeCluster,
  clearClusters,
  getClusterStats,
  type SignatureCluster,
} from './signature';

// Proposal draft
export {
  draftProposal,
  assessRisk,
  type ProposalDraft,
} from './proposal-draft';

// Store
export {
  EvolutionStore,
  createEvolutionStore,
} from './store';

// Log Analyzer (Dual-trackLog Analysis)
export {
  LogAnalyzer,
  createLogAnalyzer,
  type LogEvent,
  type LlmCallEvent,
  type ToolCallEvent,
  type UserCorrectionEvent,
  type Pattern,
  type AnalysisResult,
} from './log-analyzer';
