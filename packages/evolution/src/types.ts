/**
 * @oa/evolution — Core Types
 *
 * Self-improvement evolution engine with signal mining and proposal system.
 *
 * The evolution engine observes agent behavior (especially failures),
 * identifies patterns, and proposes improvements. It operates in three modes:
 * - OFF: No evolution activity.
 * - CAUTIOUS: Records signals but requires explicit user approval.
 * - ACTIVE: Records signals and auto-applies safe proposals.
 *
 * Default mode is OFF — the user must explicitly enable evolution.
 */

// ---------------------------------------------------------------------------
// Evolution modes
// ---------------------------------------------------------------------------

/**
 * Operating modes for the evolution engine.
 */
export enum EvolutionMode {
  /** Evolution is disabled. No signals recorded. */
  OFF = 'OFF',
  /**
   * Cautious mode: signals are recorded and proposals generated,
   * but all proposals require explicit user approval.
   */
  CAUTIOUS = 'CAUTIOUS',
  /**
   * Active mode: signals are recorded and safe proposals are
   * auto-applied. Risky proposals still require approval.
   */
  ACTIVE = 'ACTIVE',
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * Types of failure signals that can be recorded.
 */
export enum SignalKind {
  /** Tool execution failed. */
  TOOL_FAILURE = 'tool_failure',
  /** LLM produced an invalid response. */
  INVALID_RESPONSE = 'invalid_response',
  /** User corrected the agent. */
  USER_CORRECTION = 'user_correction',
  /** Task completed but with errors. */
  PARTIAL_SUCCESS = 'partial_success',
  /** Agent got stuck in a loop. */
  STUCK_LOOP = 'stuck_loop',
  /** Timeout occurred. */
  TIMEOUT = 'timeout',
  /** Security check triggered. */
  SECURITY_TRIGGER = 'security_trigger',
}

/**
 * A recorded signal representing a failure or correction event.
 */
export interface Signal {
  /** Unique signal ID. */
  id: string;
  /** The type of signal. */
  kind: SignalKind;
  /** The tool involved (if applicable). */
  toolName?: string;
  /** The raw error message or description. */
  rawMessage: string;
  /** The normalized message (PII/sensitive data redacted). */
  normalizedMessage: string;
  /** The generated signature for clustering. */
  signature: string;
  /** Session ID where the signal occurred. */
  sessionId: string;
  /** Timestamp when the signal was recorded. */
  timestamp: number;
  /** Additional context. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/**
 * Status of an evolution proposal.
 */
export enum ProposalStatus {
  /** Proposal is open, awaiting decision. */
  OPEN = 'OPEN',
  /** Proposal was accepted and applied. */
  ACCEPTED = 'ACCEPTED',
  /** Proposal was rejected. */
  REJECTED = 'REJECTED',
  /** Proposal expired without decision. */
  EXPIRED = 'EXPIRED',
  /** Proposal was auto-applied (active mode). */
  AUTO_APPLIED = 'AUTO_APPLIED',
}

/**
 * Risk level of a proposed change.
 */
export enum ProposalRisk {
  /** Safe change — no behavior impact. */
  LOW = 'LOW',
  /** Moderate change — some behavior impact. */
  MEDIUM = 'MEDIUM',
  /** Significant change — major behavior impact. */
  HIGH = 'HIGH',
}

/**
 * An evolution proposal — a suggested improvement based on signal patterns.
 */
export interface Proposal {
  /** Unique proposal ID. */
  id: string;
  /** The signal signature this proposal addresses. */
  signature: string;
  /** The kind of signal. */
  kind: SignalKind;
  /** The tool involved (if applicable). */
  toolName?: string;
  /** Human-readable title. */
  title: string;
  /** Detailed description of the proposal. */
  description: string;
  /** The proposed change (diff or instruction). */
  proposedChange: string;
  /** Risk level of the change. */
  riskLevel: ProposalRisk;
  /** Number of signals supporting this proposal. */
  signalCount: number;
  /** The signals that support this proposal. */
  supportingSignals: string[];
  /** Current status. */
  status: ProposalStatus;
  /** When the proposal was created. */
  createdAt: number;
  /** When the proposal was decided. */
  decidedAt?: number;
  /** User who decided (or 'system' for auto-apply). */
  decidedBy?: string;
  /** Expiration timestamp. */
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// Mode policy
// ---------------------------------------------------------------------------

/**
 * Policy controlling what the evolution engine can do in each mode.
 */
export interface ModePolicy {
  /** Whether to record signals. */
  recordSignals: boolean;
  /** Whether to mine for proposals. */
  mineProposals: boolean;
  /** Whether to auto-apply LOW risk proposals. */
  autoApplyLowRisk: boolean;
  /** Whether to auto-apply MEDIUM risk proposals. */
  autoApplyMediumRisk: boolean;
  /** Whether HIGH risk proposals require approval (always true). */
  requireApprovalHighRisk: boolean;
  /** Maximum proposals to generate per mining run. */
  maxProposalsPerMine: number;
  /** Minimum signal count to generate a proposal. */
  minSignalsForProposal: number;
  /** Cooldown after rejection in milliseconds. */
  rejectionCooldownMs: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the evolution engine.
 */
export interface EvolutionConfig {
  /** Current evolution mode. */
  mode: EvolutionMode;
  /** Minimum signals before mining for proposals. */
  minSignalsForMining: number;
  /** Maximum proposals to generate per mining run. */
  maxProposalsPerMine: number;
  /** Minimum signal count to generate a proposal. */
  minSignalsForProposal: number;
  /** Cooldown after a proposal is rejected (ms). */
  rejectionCooldownMs: number;
  /** Proposal expiration time (ms). */
  proposalExpirationMs: number;
  /** LLM client for generating proposal drafts. */
  llmClient?: import('@oa/llm').LlmClient;
  /** Model to use for proposal generation. */
  proposalModel?: string;
  /** Whether to emit events for audit trail. */
  emitEvents: boolean;
  /** Custom mode policies (merged with defaults). */
  modePolicies?: Partial<Record<EvolutionMode, Partial<ModePolicy>>>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EvolutionEventType =
  | 'evolution:signal_recorded'
  | 'evolution:proposal_created'
  | 'evolution:proposal_accepted'
  | 'evolution:proposal_rejected'
  | 'evolution:mode_changed'
  | 'evolution:mine_completed';

export interface EvolutionEvent {
  type: EvolutionEventType;
  timestamp: number;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  mode: EvolutionMode.OFF,
  minSignalsForMining: 3,
  maxProposalsPerMine: 5,
  minSignalsForProposal: 2,
  rejectionCooldownMs: 300_000, // 5 minutes
  proposalExpirationMs: 86_400_000, // 24 hours
  proposalModel: 'gpt-4o-mini',
  emitEvents: true,
};

/**
 * Default mode policies.
 */
export const DEFAULT_MODE_POLICIES: Record<EvolutionMode, ModePolicy> = {
  [EvolutionMode.OFF]: {
    recordSignals: false,
    mineProposals: false,
    autoApplyLowRisk: false,
    autoApplyMediumRisk: false,
    requireApprovalHighRisk: true,
    maxProposalsPerMine: 0,
    minSignalsForProposal: 999,
    rejectionCooldownMs: 300_000,
  },
  [EvolutionMode.CAUTIOUS]: {
    recordSignals: true,
    mineProposals: true,
    autoApplyLowRisk: false,
    autoApplyMediumRisk: false,
    requireApprovalHighRisk: true,
    maxProposalsPerMine: 5,
    minSignalsForProposal: 2,
    rejectionCooldownMs: 300_000,
  },
  [EvolutionMode.ACTIVE]: {
    recordSignals: true,
    mineProposals: true,
    autoApplyLowRisk: true,
    autoApplyMediumRisk: false,
    requireApprovalHighRisk: true,
    maxProposalsPerMine: 10,
    minSignalsForProposal: 2,
    rejectionCooldownMs: 300_000,
  },
};
