/**
 * @oa/evolution — EvolutionEngine
 *
 * Self-improvement engine that observes agent behavior, identifies
 * failure patterns, and proposes improvements.
 *
 * Workflow:
 * 1. record(signal) — Record a failure signal
 * 2. mine() — Mine hot signatures for proposals
 * 3. listProposals() — List open proposals
 * 4. decide(proposalId, accept) — User decides on a proposal
 *
 * The engine operates in three modes (default: OFF):
 * - OFF: No activity
 * - CAUTIOUS: Record + mine, require approval
 * - ACTIVE: Record + mine + auto-apply safe proposals
 *
 * After a proposal is rejected, a cooldown prevents re-proposing
 * the same pattern for a configurable period.
 */

import type { LlmMessage } from '@oa/llm';
import type {
  EvolutionConfig,
  EvolutionEvent,
  EvolutionMode,
  ModePolicy,
  Proposal,
  ProposalRisk,
  ProposalStatus,
  Signal,
  SignalKind,
} from './types';
import {
  DEFAULT_EVOLUTION_CONFIG,
  DEFAULT_MODE_POLICIES,
  EvolutionMode as Mode,
  ProposalRisk as Risk,
  ProposalStatus as Status,
  SignalKind as Kind,
} from './types';
import { normalizeSignal } from './normalizer';
import {
  addToCluster,
  generateSignature,
  getClustersWithMinCount,
  type SignatureCluster,
} from './signature';
import { draftProposal, assessRisk } from './proposal-draft';
import { EvolutionStore, createEvolutionStore } from './store';
import type { DatabaseManager } from '@oa/storage';

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

export type EvolutionEventHandler = (event: EvolutionEvent) => void;

// ---------------------------------------------------------------------------
// EvolutionEngine
// ---------------------------------------------------------------------------

export class EvolutionEngine {
  private readonly config: EvolutionConfig;
  private mode: EvolutionMode;
  private readonly store: EvolutionStore;
  private readonly eventHandlers: Set<EvolutionEventHandler> = new Set();
  private readonly modePolicies: Record<EvolutionMode, ModePolicy>;

  constructor(
    config: Partial<EvolutionConfig> = {},
    store?: EvolutionStore
  ) {
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
    this.mode = this.config.mode;

    // Initialize store
    if (store) {
      this.store = store;
    } else {
      // Create an isolated in-memory store
      const { createDatabase } = this.loadStorage();
      const db = createDatabase({ dbPath: ':memory:' });
      this.store = createEvolutionStore(db);
    }

    // Initialize mode policies
    this.modePolicies = { ...DEFAULT_MODE_POLICIES };
    if (config.modePolicies) {
      for (const [mode, policy] of Object.entries(config.modePolicies)) {
        const modeKey = mode as EvolutionMode;
        if (this.modePolicies[modeKey]) {
          this.modePolicies[modeKey] = { ...this.modePolicies[modeKey], ...policy };
        }
      }
    }

    // Sync mode from store if available
    const storedMode = this.store.getMode();
    if (storedMode) {
      this.mode = storedMode;
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic import helper (avoids hard dependency at module load)
  // -------------------------------------------------------------------------

  private loadStorage(): typeof import('@oa/storage') {
    // In a real ESM environment, this would be a top-level dynamic import.
    // For TypeScript compatibility, we use require-like pattern.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('@oa/storage') as typeof import('@oa/storage');
    } catch {
      throw new Error('EvolutionEngine requires @oa/storage for default store');
    }
  }

  // -------------------------------------------------------------------------
  // Event system
  // -------------------------------------------------------------------------

  /**
   * Subscribe to evolution events.
   */
  onEvent(handler: EvolutionEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: EvolutionEvent): void {
    if (!this.config.emitEvents) return;
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Handlers must not break the engine
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mode management
  // -------------------------------------------------------------------------

  /**
   * Get the current evolution mode.
   */
  getMode(): EvolutionMode {
    return this.mode;
  }

  /**
   * Set the evolution mode.
   *
   * @param mode The new mode.
   * @param changedBy Who changed the mode (for audit).
   */
  setMode(mode: EvolutionMode, changedBy: string = 'user'): void {
    const previousMode = this.mode;
    this.mode = mode;
    this.store.setMode(mode, changedBy);

    this.emit({
      type: 'evolution:mode_changed',
      timestamp: Date.now(),
      data: { from: previousMode, to: mode, changedBy },
    });
  }

  /**
   * Get the current mode policy.
   */
  getModePolicy(): ModePolicy {
    return this.modePolicies[this.mode];
  }

  // -------------------------------------------------------------------------
  // Signal recording
  // -------------------------------------------------------------------------

  /**
   * Record a failure signal.
   *
   * The signal is normalized, signed, and stored. If the current mode
   * doesn't allow recording, the signal is silently dropped.
   *
   * @param signal The signal to record (without normalized/signature fields).
   * @returns The recorded signal, or null if recording is disabled.
   */
  record(signal: {
    kind: SignalKind;
    toolName?: string;
    rawMessage: string;
    sessionId: string;
    metadata?: Record<string, unknown>;
  }): Signal | null {
    const policy = this.getModePolicy();
    if (!policy.recordSignals) return null;

    // Normalize the message
    const normalizedMessage = normalizeSignal(signal.rawMessage);

    // Generate signature
    const signature = generateSignature(signal.kind, signal.toolName, normalizedMessage);

    // Create full signal
    const fullSignal: Signal = {
      id: `sig_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      kind: signal.kind,
      toolName: signal.toolName,
      rawMessage: signal.rawMessage,
      normalizedMessage,
      signature,
      sessionId: signal.sessionId,
      timestamp: Date.now(),
      metadata: signal.metadata,
    };

    // Store signal
    this.store.storeSignal(fullSignal);

    // Add to in-memory cluster
    addToCluster(signature, {
      id: fullSignal.id,
      kind: fullSignal.kind,
      toolName: fullSignal.toolName,
      normalizedMessage: fullSignal.normalizedMessage,
      timestamp: fullSignal.timestamp,
    });

    // Emit event
    this.emit({
      type: 'evolution:signal_recorded',
      timestamp: Date.now(),
      data: { signalId: fullSignal.id, signature, kind: signal.kind },
    });

    return fullSignal;
  }

  // -------------------------------------------------------------------------
  // Mining
  // -------------------------------------------------------------------------

  /**
   * Mine hot signatures for proposals.
   *
   * Analyzes signal clusters to find patterns that meet the minimum
   * signal count threshold, then generates proposals for them.
   *
   * Respects rejection cooldowns — signatures in cooldown are skipped.
   *
   * @returns Array of newly created proposals.
   */
  mine(): Proposal[] {
    const policy = this.getModePolicy();
    if (!policy.mineProposals) return [];

    const minCount = Math.max(this.config.minSignalsForProposal, policy.minSignalsForProposal);
    const clusters = getClustersWithMinCount(minCount);
    const proposals: Proposal[] = [];

    for (const cluster of clusters) {
      // Skip if in cooldown
      if (this.store.isInCooldown(cluster.signature)) continue;

      // Skip if there's already an open proposal for this signature
      const existingProposals = this.store.getProposalsBySignature(cluster.signature);
      const hasOpen = existingProposals.some((p) => p.status === Status.OPEN);
      if (hasOpen) continue;

      // Skip if max proposals reached
      if (proposals.length >= policy.maxProposalsPerMine) break;

      // Generate proposal
      const proposal = this.createProposal(cluster);
      if (proposal) {
        proposals.push(proposal);
      }
    }

    // Emit event
    this.emit({
      type: 'evolution:mine_completed',
      timestamp: Date.now(),
      data: { proposalsCreated: proposals.length, signaturesScanned: clusters.length },
    });

    return proposals;
  }

  /**
   * Create a proposal from a signal cluster.
   */
  private createProposal(cluster: SignatureCluster): Proposal | null {
    // Draft the proposal
    const draft = draftProposal(cluster);

    // Assess risk
    const riskLevel = assessRisk(cluster, draft);

    // Get supporting signals
    const supportingSignals = this.store.getSignalsBySignature(cluster.signature);

    const proposal: Proposal = {
      id: `prop_${cluster.signature}_${Date.now()}`,
      signature: cluster.signature,
      kind: cluster.kind,
      toolName: cluster.toolName,
      title: draft.title,
      description: draft.description,
      proposedChange: draft.proposedChange,
      riskLevel,
      signalCount: cluster.count,
      supportingSignals: supportingSignals.map((s) => s.id),
      status: Status.OPEN,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.proposalExpirationMs,
    };

    // Store proposal
    this.store.storeProposal(proposal);

    // Auto-apply if mode allows and risk is low enough
    const policy = this.getModePolicy();
    const shouldAutoApply =
      (riskLevel === Risk.LOW && policy.autoApplyLowRisk) ||
      (riskLevel === Risk.MEDIUM && policy.autoApplyMediumRisk);

    if (shouldAutoApply) {
      this.applyProposal(proposal.id, 'system');
    }

    // Emit event
    this.emit({
      type: 'evolution:proposal_created',
      timestamp: Date.now(),
      data: {
        proposalId: proposal.id,
        signature: proposal.signature,
        title: proposal.title,
        riskLevel: proposal.riskLevel,
        autoApplied: shouldAutoApply,
      },
    });

    return proposal;
  }

  // -------------------------------------------------------------------------
  // Proposal management
  // -------------------------------------------------------------------------

  /**
   * List all open proposals.
   */
  listProposals(status: ProposalStatus = Status.OPEN): Proposal[] {
    if (status === Status.OPEN) {
      return this.store.getOpenProposals();
    }
    return this.store.getProposalsByStatus(status);
  }

  /**
   * Get a single proposal by ID.
   */
  getProposal(id: string): Proposal | null {
    return this.store.getProposal(id);
  }

  /**
   * Decide on a proposal (accept or reject).
   *
   * @param proposalId The proposal ID.
   * @param accept Whether to accept (true) or reject (false).
   * @param decidedBy Who made the decision.
   * @returns The updated proposal, or null if not found.
   */
  decide(proposalId: string, accept: boolean, decidedBy: string = 'user'): Proposal | null {
    const proposal = this.store.getProposal(proposalId);
    if (!proposal) return null;

    if (accept) {
      // Accept — apply the proposal
      this.applyProposal(proposalId, decidedBy);
    } else {
      // Reject — start cooldown
      this.rejectProposal(proposalId, decidedBy);
    }

    return this.store.getProposal(proposalId) ?? null;
  }

  /**
   * Apply a proposal.
   */
  private applyProposal(proposalId: string, appliedBy: string): void {
    const now = Date.now();
    this.store.updateProposalStatus(
      proposalId,
      Status.ACCEPTED,
      appliedBy,
      now
    );

    // In a real implementation, the proposal's proposedChange would be
    // applied to the agent's configuration, system prompt, or behavior rules.
    // For now, we record the acceptance.

    this.emit({
      type: 'evolution:proposal_accepted',
      timestamp: now,
      data: { proposalId, appliedBy },
    });
  }

  /**
   * Reject a proposal and start cooldown.
   */
  private rejectProposal(proposalId: string, rejectedBy: string): void {
    const now = Date.now();
    this.store.updateProposalStatus(
      proposalId,
      Status.REJECTED,
      rejectedBy,
      now
    );

    // Start cooldown for this signature
    const proposal = this.store.getProposal(proposalId);
    if (proposal) {
      this.store.recordRejection(proposal.signature, this.config.rejectionCooldownMs);
    }

    this.emit({
      type: 'evolution:proposal_rejected',
      timestamp: now,
      data: { proposalId, rejectedBy, cooldownMs: this.config.rejectionCooldownMs },
    });
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /**
   * Get evolution statistics.
   */
  getStats(): {
    mode: EvolutionMode;
    signalCount: number;
    proposalCount: number;
    openProposals: number;
    acceptedProposals: number;
    rejectedProposals: number;
    cooldownsActive: number;
  } {
    return {
      mode: this.mode,
      signalCount: this.store.getSignalCount(),
      proposalCount: this.store.getProposalCount(),
      openProposals: this.store.getProposalsByStatus(Status.OPEN).length,
      acceptedProposals: this.store.getProposalsByStatus(Status.ACCEPTED).length,
      rejectedProposals: this.store.getProposalsByStatus(Status.REJECTED).length,
      cooldownsActive: 0, // Would query active cooldowns from store
    };
  }

  /**
   * Get the underlying store (for advanced usage).
   */
  getStore(): EvolutionStore {
    return this.store;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an EvolutionEngine instance.
 */
export function createEvolutionEngine(config: Partial<EvolutionConfig> = {}): EvolutionEngine {
  return new EvolutionEngine(config);
}

// Re-export store factory
export { createEvolutionStore } from './store';
