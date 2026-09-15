/**
 * @oa/evolution — EvolutionStore
 *
 * Isolated SQLite storage for the evolution engine.
 * Stores signals, proposals, and mode state in a dedicated database
 * separate from the main event store.
 *
 * Tables:
 * - signals: Recorded failure signals
 * - proposals: Evolution proposals
 * - mode_state: Current evolution mode and metadata
 * - rejection_cooldowns: Cooldown tracking after rejections
 */

import type { DatabaseManager } from '@oa/storage';
import type { Signal, Proposal, EvolutionMode, SignalKind, ProposalStatus } from './types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SIGNALS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS evolution_signals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    tool_name TEXT,
    raw_message TEXT NOT NULL,
    normalized_message TEXT NOT NULL,
    signature TEXT NOT NULL,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    metadata TEXT
  );
`;

const SIGNALS_SIGNATURE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_signals_signature ON evolution_signals(signature);
`;

const SIGNALS_KIND_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_signals_kind ON evolution_signals(kind);
`;

const PROPOSALS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS evolution_proposals (
    id TEXT PRIMARY KEY,
    signature TEXT NOT NULL,
    kind TEXT NOT NULL,
    tool_name TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    proposed_change TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    signal_count INTEGER NOT NULL,
    supporting_signals TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    expires_at INTEGER
  );
`;

const PROPOSALS_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_proposals_status ON evolution_proposals(status);
`;

const PROPOSALS_SIGNATURE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_proposals_signature ON evolution_proposals(signature);
`;

const MODE_STATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS evolution_mode_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );
`;

const REJECTION_COOLDOWNS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS evolution_rejection_cooldowns (
    signature TEXT PRIMARY KEY,
    rejected_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      ${SIGNALS_TABLE_SQL}
      ${SIGNALS_SIGNATURE_INDEX_SQL}
      ${SIGNALS_KIND_INDEX_SQL}
      ${PROPOSALS_TABLE_SQL}
      ${PROPOSALS_STATUS_INDEX_SQL}
      ${PROPOSALS_SIGNATURE_INDEX_SQL}
      ${MODE_STATE_TABLE_SQL}
      ${REJECTION_COOLDOWNS_TABLE_SQL}
    `,
  },
];

// ---------------------------------------------------------------------------
// EvolutionStore
// ---------------------------------------------------------------------------

export class EvolutionStore {
  private readonly db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
    this.ensureSchema();
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private ensureSchema(): void {
    const currentVersion = this.db.getSchemaVersion('evolution');
    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        this.db.exec(migration.sql);
        this.db.setSchemaVersion('evolution', migration.version);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Signals
  // -------------------------------------------------------------------------

  /**
   * Store a signal.
   */
  storeSignal(signal: Signal): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO evolution_signals
        (id, kind, tool_name, raw_message, normalized_message, signature, session_id, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      signal.id,
      signal.kind,
      signal.toolName ?? null,
      signal.rawMessage,
      signal.normalizedMessage,
      signal.signature,
      signal.sessionId,
      signal.timestamp,
      signal.metadata ? JSON.stringify(signal.metadata) : null
    );
  }

  /**
   * Get a signal by ID.
   */
  getSignal(id: string): Signal | null {
    const row = this.db.prepare(
      'SELECT * FROM evolution_signals WHERE id = ?'
    ).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToSignal(row);
  }

  /**
   * Get all signals with a specific signature.
   */
  getSignalsBySignature(signature: string): Signal[] {
    const rows = this.db.prepare(
      'SELECT * FROM evolution_signals WHERE signature = ? ORDER BY timestamp DESC'
    ).all(signature) as Record<string, unknown>[];

    return rows.map((r) => this.rowToSignal(r));
  }

  /**
   * Get signals by kind.
   */
  getSignalsByKind(kind: SignalKind): Signal[] {
    const rows = this.db.prepare(
      'SELECT * FROM evolution_signals WHERE kind = ? ORDER BY timestamp DESC'
    ).all(kind) as Record<string, unknown>[];

    return rows.map((r) => this.rowToSignal(r));
  }

  /**
   * Get all signals (paginated).
   */
  getSignals(limit: number = 100, offset: number = 0): Signal[] {
    const rows = this.db.prepare(
      'SELECT * FROM evolution_signals ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as Record<string, unknown>[];

    return rows.map((r) => this.rowToSignal(r));
  }

  /**
   * Count signals by signature.
   */
  countSignalsBySignature(signature: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM evolution_signals WHERE signature = ?'
    ).get(signature) as { count: number };
    return row.count;
  }

  /**
   * Get signal count.
   */
  getSignalCount(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM evolution_signals'
    ).get() as { count: number };
    return row.count;
  }

  /**
   * Delete old signals (older than `beforeTimestamp`).
   */
  deleteSignalsBefore(beforeTimestamp: number): number {
    const result = this.db.prepare(
      'DELETE FROM evolution_signals WHERE timestamp < ?'
    ).run(beforeTimestamp);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Proposals
  // -------------------------------------------------------------------------

  /**
   * Store a proposal.
   */
  storeProposal(proposal: Proposal): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO evolution_proposals
        (id, signature, kind, tool_name, title, description, proposed_change,
         risk_level, signal_count, supporting_signals, status, created_at,
         decided_at, decided_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.id,
      proposal.signature,
      proposal.kind,
      proposal.toolName ?? null,
      proposal.title,
      proposal.description,
      proposal.proposedChange,
      proposal.riskLevel,
      proposal.signalCount,
      JSON.stringify(proposal.supportingSignals),
      proposal.status,
      proposal.createdAt,
      proposal.decidedAt ?? null,
      proposal.decidedBy ?? null,
      proposal.expiresAt ?? null
    );
  }

  /**
   * Get a proposal by ID.
   */
  getProposal(id: string): Proposal | null {
    const row = this.db.prepare(
      'SELECT * FROM evolution_proposals WHERE id = ?'
    ).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToProposal(row);
  }

  /**
   * Get proposals by status.
   */
  getProposalsByStatus(status: ProposalStatus): Proposal[] {
    const rows = this.db.prepare(
      'SELECT * FROM evolution_proposals WHERE status = ? ORDER BY created_at DESC'
    ).all(status) as Record<string, unknown>[];

    return rows.map((r) => this.rowToProposal(r));
  }

  /**
   * Get all open proposals.
   */
  getOpenProposals(): Proposal[] {
    return this.getProposalsByStatus(ProposalStatus.OPEN);
  }

  /**
   * Get proposals by signature.
   */
  getProposalsBySignature(signature: string): Proposal[] {
    const rows = this.db.prepare(
      'SELECT * FROM evolution_proposals WHERE signature = ? ORDER BY created_at DESC'
    ).all(signature) as Record<string, unknown>[];

    return rows.map((r) => this.rowToProposal(r));
  }

  /**
   * Update proposal status.
   */
  updateProposalStatus(
    id: string,
    status: ProposalStatus,
    decidedBy: string,
    decidedAt: number = Date.now()
  ): void {
    this.db.prepare(
      'UPDATE evolution_proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?'
    ).run(status, decidedBy, decidedAt, id);
  }

  /**
   * Get proposal count.
   */
  getProposalCount(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM evolution_proposals'
    ).get() as { count: number };
    return row.count;
  }

  /**
   * Delete expired proposals.
   */
  deleteExpiredProposals(beforeTimestamp: number): number {
    const result = this.db.prepare(
      'DELETE FROM evolution_proposals WHERE status = ? AND expires_at < ?'
    ).run(ProposalStatus.OPEN, beforeTimestamp);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Mode state
  // -------------------------------------------------------------------------

  /**
   * Get the current evolution mode.
   */
  getMode(): EvolutionMode {
    const row = this.db.prepare(
      'SELECT mode FROM evolution_mode_state WHERE id = 1'
    ).get() as { mode: string } | undefined;

    return (row?.mode as EvolutionMode) ?? EvolutionMode.OFF;
  }

  /**
   * Set the evolution mode.
   */
  setMode(mode: EvolutionMode, updatedBy: string = 'system'): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO evolution_mode_state (id, mode, updated_at, updated_by)
      VALUES (1, ?, ?, ?)
    `).run(mode, Date.now(), updatedBy);
  }

  // -------------------------------------------------------------------------
  // Rejection cooldowns
  // -------------------------------------------------------------------------

  /**
   * Record a rejection cooldown.
   */
  recordRejection(signature: string, cooldownMs: number): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO evolution_rejection_cooldowns (signature, rejected_at, expires_at)
      VALUES (?, ?, ?)
    `).run(signature, now, now + cooldownMs);
  }

  /**
   * Check if a signature is in cooldown.
   */
  isInCooldown(signature: string): boolean {
    const row = this.db.prepare(
      'SELECT expires_at FROM evolution_rejection_cooldowns WHERE signature = ? AND expires_at > ?'
    ).get(signature, Date.now()) as { expires_at: number } | undefined;

    return row !== undefined;
  }

  /**
   * Get remaining cooldown in ms.
   */
  getCooldownRemaining(signature: string): number {
    const row = this.db.prepare(
      'SELECT expires_at FROM evolution_rejection_cooldowns WHERE signature = ?'
    ).get(signature) as { expires_at: number } | undefined;

    if (!row) return 0;
    return Math.max(0, row.expires_at - Date.now());
  }

  /**
   * Clear expired cooldowns.
   */
  clearExpiredCooldowns(): number {
    const result = this.db.prepare(
      'DELETE FROM evolution_rejection_cooldowns WHERE expires_at <= ?'
    ).run(Date.now());
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Row mappers
  // -------------------------------------------------------------------------

  private rowToSignal(row: Record<string, unknown>): Signal {
    return {
      id: row.id as string,
      kind: row.kind as SignalKind,
      toolName: row.tool_name as string | undefined,
      rawMessage: row.raw_message as string,
      normalizedMessage: row.normalized_message as string,
      signature: row.signature as string,
      sessionId: row.session_id as string,
      timestamp: row.timestamp as number,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };
  }

  private rowToProposal(row: Record<string, unknown>): Proposal {
    return {
      id: row.id as string,
      signature: row.signature as string,
      kind: row.kind as SignalKind,
      toolName: row.tool_name as string | undefined,
      title: row.title as string,
      description: row.description as string,
      proposedChange: row.proposed_change as string,
      riskLevel: row.risk_level as Proposal['riskLevel'],
      signalCount: row.signal_count as number,
      supportingSignals: JSON.parse(row.supporting_signals as string),
      status: row.status as ProposalStatus,
      createdAt: row.created_at as number,
      decidedAt: row.decided_at as number | undefined,
      decidedBy: row.decided_by as string | undefined,
      expiresAt: row.expires_at as number | undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an EvolutionStore instance.
 */
export function createEvolutionStore(db: DatabaseManager): EvolutionStore {
  return new EvolutionStore(db);
}
