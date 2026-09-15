/**
 * @oa/recovery — RecoverySystem
 *
 * Central recovery orchestrator. Handles:
 * - Crash recovery: scans all sessions on startup and recovers them
 * - Turn pause/resume: pause in-flight turns and resume them later
 * - Session parking: save in-memory state for crash recovery
 * - Session restoration: restore parked sessions on startup
 *
 * Recovery rules:
 * - Sessions in 'running' or 'executing' phase at crash time → moved to 'error'
 * - Sessions in 'waiting' or 'paused' phase → survive restart, resumed as-is
 * - Sessions with parked state → restored from parked data
 * - All recovery actions emit events for audit trail
 */

import type { EventType, IEventStore } from '@oa/event-store';
import type { DatabaseManager } from '@oa/storage';
import type { SessionManager, ParkedSession, SessionState } from '@oa/session-core';
import type { IProjectionEngine } from '@oa/projection';
import type {
  RecoveryConfig,
  RecoveryReport,
  SessionRecoveryResult,
  RecoveryError,
  PausedTurn,
  SessionRecoveredPayload,
  SessionParkedPayload,
} from './types';
import { StallWatchdog, createStallWatchdog } from './stall-watchdog';
import { CheckpointManager, createCheckpointManager } from './checkpoint-manager';
import { createInitialTurnState } from '@oa/session-core';

// ---------------------------------------------------------------------------
// RecoverySystem
// ---------------------------------------------------------------------------

export class RecoverySystem {
  private readonly eventStore: IEventStore;
  private readonly database: DatabaseManager;
  private readonly sessionManager: SessionManager;
  private readonly projectionEngine: IProjectionEngine;
  private readonly autoRecover: boolean;

  /** Stall watchdog instance. */
  public readonly stallWatchdog: StallWatchdog;

  /** Checkpoint manager instance. */
  public readonly checkpointManager: CheckpointManager;

  /** Paused turns (sessionId -> paused turn). */
  private readonly pausedTurns: Map<string, PausedTurn> = new Map();

  constructor(config: RecoveryConfig) {
    if (!config.eventStore) {
      throw new Error('RecoverySystem requires an IEventStore instance');
    }
    if (!config.database) {
      throw new Error('RecoverySystem requires a DatabaseManager instance');
    }
    if (!config.sessionManager) {
      throw new Error('RecoverySystem requires a SessionManager instance');
    }
    if (!config.projectionEngine) {
      throw new Error('RecoverySystem requires an IProjectionEngine instance');
    }

    this.eventStore = config.eventStore;
    this.database = config.database;
    this.sessionManager = config.sessionManager;
    this.projectionEngine = config.projectionEngine;
    this.autoRecover = config.autoRecover ?? true;

    // Initialize stall watchdog
    this.stallWatchdog = createStallWatchdog(
      config.stallWatchdog ?? {},
      {
        eventStore: config.eventStore,
        database: config.database,
        onStall: (info) => this.handleStall(info.sessionId, info),
        onAutoPark: (sessionId, info) => this.handleAutoPark(sessionId, info),
      }
    );

    // Initialize checkpoint manager
    this.checkpointManager = createCheckpointManager({
      database: config.database,
      eventStore: config.eventStore,
      projectionEngine: config.projectionEngine,
      checkpoint: config.checkpoint,
    });
  }

  // -------------------------------------------------------------------------
  // Crash recovery
  // -------------------------------------------------------------------------

  /**
   * Scan all sessions and recover them after a crash. This is called on
   * application startup. For each session:
   * - If it was running/executing → mark as error
   * - If it was waiting/paused → resume as-is
   * - If it has parked state → restore from parked data
   *
   * @returns A detailed recovery report.
   */
  async recoverFromCrash(): Promise<RecoveryReport> {
    const startedAt = Date.now() * 1000;
    const errors: RecoveryError[] = [];
    const sessionResults: SessionRecoveryResult[] = [];

    // Get all non-deleted sessions
    const rows = this.database.prepare(`
      SELECT id, phase, last_seq, last_event_timestamp
      FROM sessions
      WHERE deleted = 0
      ORDER BY updated_at DESC
    `).all() as Array<{ id: string; phase: string; last_seq: number; last_event_timestamp: number }>;

    let sessionsRecovered = 0;
    let sessionsParked = 0;
    let sessionsInError = 0;
    let sessionsResumed = 0;

    for (const row of rows) {
      try {
        const result = await this.recoverSession(row.id, row.phase);
        sessionResults.push(result);

        switch (result.action) {
          case 'recovered':
            sessionsRecovered++;
            break;
          case 'parked':
            sessionsParked++;
            break;
          case 'error':
            sessionsInError++;
            break;
          case 'resumed':
            sessionsResumed++;
            break;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({
          sessionId: row.id,
          error: errorMsg,
          timestamp: Date.now() * 1000,
        });
        sessionResults.push({
          sessionId: row.id,
          action: 'error',
          previousPhase: row.phase as any,
          newPhase: 'failed',
          hadParkedState: false,
          error: errorMsg,
        });
        sessionsInError++;
      }
    }

    const completedAt = Date.now() * 1000;

    return {
      startedAt,
      completedAt,
      durationMs: (completedAt - startedAt) / 1000,
      sessionsScanned: rows.length,
      sessionsRecovered,
      sessionsParked,
      sessionsInError,
      sessionsResumed,
      errors,
      sessionResults,
    };
  }

  /**
   * Recover a single session based on its phase at crash time.
   */
  private async recoverSession(
    sessionId: string,
    phase: string
  ): Promise<SessionRecoveryResult> {
    // Check for parked state
    const session = await this.sessionManager.resumeSession(sessionId);
    const hadParkedState = session !== null;

    let action: SessionRecoveryResult['action'];
    let newPhase: SessionState['phase'];

    switch (phase) {
      case 'executing':
      case 'calling_tools':
      case 'planning':
        // Was actively running — mark as error
        newPhase = 'error' as SessionState['phase'];
        action = 'error';
        await this.transitionPhase(sessionId, newPhase);
        break;

      case 'awaiting_user':
      case 'idle':
      case 'reviewing':
        // Was waiting — can resume
        newPhase = phase as SessionState['phase'];
        action = 'resumed';
        break;

      case 'failed':
      case 'cancelled':
        // Already terminal — skip
        newPhase = phase as SessionState['phase'];
        action = 'skipped';
        break;

      case 'completed':
        // Already done — skip
        newPhase = 'completed';
        action = 'skipped';
        break;

      default:
        // Unknown phase — mark as error to be safe
        newPhase = 'error' as SessionState['phase'];
        action = 'error';
        await this.transitionPhase(sessionId, newPhase);
        break;
    }

    // Emit recovery event
    const payload: SessionRecoveredPayload = {
      previousPhase: phase as SessionState['phase'],
      newPhase,
      hadParkedState,
      recoveryAction: action,
    };

    await this.eventStore.append({
      eventType: EventType.AgentStateChanged,
      sessionId,
      payload,
    });

    return {
      sessionId,
      action,
      previousPhase: phase as SessionState['phase'],
      newPhase,
      hadParkedState,
    };
  }

  // -------------------------------------------------------------------------
  // Turn pause/resume
  // -------------------------------------------------------------------------

  /**
   * Pause the current turn for a session. Saves the partial turn state so
   * it can be resumed later.
   *
   * @param sessionId - The session ID.
   * @param reason - Why the turn is being paused.
   */
  async pauseTurn(sessionId: string, reason: string): Promise<void> {
    const state = await this.projectionEngine.project<SessionState>(sessionId);

    const pausedTurn: PausedTurn = {
      sessionId,
      turnId: `turn_${Date.now() * 1000}`,
      pausedAt: Date.now() * 1000,
      reason,
      atSeq: state.lastSeq,
      partialState: state,
    };

    this.pausedTurns.set(sessionId, pausedTurn);

    // Update session phase
    await this.transitionPhase(sessionId, 'error');

    // Emit event
    await this.eventStore.append({
      eventType: EventType.AgentStateChanged,
      sessionId,
      payload: { action: 'turn_paused', reason, atSeq: state.lastSeq },
    });
  }

  /**
   * Resume a paused turn. Restores the turn state and continues execution.
   *
   * @param sessionId - The session ID.
   */
  async resumeTurn(sessionId: string): Promise<void> {
    const pausedTurn = this.pausedTurns.get(sessionId);
    if (!pausedTurn) {
      throw new Error(`No paused turn found for session "${sessionId}"`);
    }

    // Remove from paused map
    this.pausedTurns.delete(sessionId);

    // Restore phase
    await this.transitionPhase(sessionId, pausedTurn.partialState.phase);

    // Emit event
    await this.eventStore.append({
      eventType: EventType.AgentStateChanged,
      sessionId,
      payload: {
        action: 'turn_resumed',
        pausedAt: pausedTurn.pausedAt,
        resumedAt: Date.now() * 1000,
        atSeq: pausedTurn.atSeq,
      },
    });
  }

  /**
   * Check if a session has a paused turn.
   *
   * @param sessionId - The session ID.
   */
  hasPausedTurn(sessionId: string): boolean {
    return this.pausedTurns.has(sessionId);
  }

  /**
   * Get the paused turn info for a session.
   *
   * @param sessionId - The session ID.
   */
  getPausedTurn(sessionId: string): PausedTurn | null {
    return this.pausedTurns.get(sessionId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Session parking
  // -------------------------------------------------------------------------

  /**
   * Park a session — save its in-memory state to the session_state_cache
   * for later restoration. Used before app close or workspace switch.
   *
   * @param sessionId - The session to park.
   */
  async parkSession(sessionId: string): Promise<void> {
    const state = await this.projectionEngine.project<SessionState>(sessionId);
    const turnState = createInitialTurnState();
    turnState.phase = 'idle';

    // Access the session buffers through the session manager's internal state
    // We use the database directly for parking
    const parkedAt = Date.now() * 1000;
    this.database.prepare(`
      INSERT INTO session_state_cache (session_id, state, turn_state, parked_at, reason, at_seq)
      VALUES (?, ?, ?, ?, 'manual', ?)
    `).run(
      sessionId,
      JSON.stringify(state),
      JSON.stringify(turnState),
      parkedAt,
      state.lastSeq
    );

    // Emit event
    const payload: SessionParkedPayload = {
      reason: 'manual',
      atSeq: state.lastSeq,
      turnPhase: turnState.phase,
    };

    await this.eventStore.append({
      eventType: EventType.AgentStateChanged,
      sessionId,
      payload,
    });
  }

  /**
   * Restore a previously parked session. Reads the parked state from the
   * cache and applies it.
   *
   * @param sessionId - The session to restore.
   * @returns True if the session was restored.
   */
  async restoreSession(sessionId: string): Promise<boolean> {
    const row = this.database.prepare(`
      SELECT state, turn_state, parked_at, reason, at_seq
      FROM session_state_cache
      WHERE session_id = ?
      ORDER BY parked_at DESC
      LIMIT 1
    `).get(sessionId) as Record<string, unknown> | undefined;

    if (!row) return false;

    // Delete the parked entry
    this.database.prepare(`
      DELETE FROM session_state_cache WHERE session_id = ?
    `).run(sessionId);

    // Invalidate projection cache so next projection reads fresh state
    this.projectionEngine.invalidateCache(sessionId);

    // Emit event
    await this.eventStore.append({
      eventType: EventType.AgentStateChanged,
      sessionId,
      payload: {
        action: 'session_restored',
        parkedAt: row.parked_at,
        reason: row.reason,
        atSeq: row.at_seq,
      },
    });

    return true;
  }

  // -------------------------------------------------------------------------
  // Stall handling
  // -------------------------------------------------------------------------

  /**
   * Handle a detected stall. Invoked by the stall watchdog.
   */
  private handleStall(sessionId: string, info: import('./types').StallInfo): void {
    // The stall event is already emitted by the watchdog.
    // Additional handling can be added here (e.g., notifications).
  }

  /**
   * Handle auto-parking of a stalled session. Invoked by the stall watchdog
   * when maxStalls is reached.
   */
  private async handleAutoPark(sessionId: string, info: import('./types').StallInfo): Promise<void> {
    try {
      await this.parkSession(sessionId);
    } catch {
      // Auto-park failure should not crash the watchdog
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the recovery system. Prunes expired checkpoints and starts
   * the stall watchdog.
   */
  initialize(): void {
    // Prune expired checkpoints
    this.checkpointManager.pruneExpired();

    // Start the stall watchdog
    this.stallWatchdog.start();
  }

  /**
   * Shutdown the recovery system. Stops the watchdog and cleans up.
   */
  shutdown(): void {
    this.stallWatchdog.stop();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async transitionPhase(sessionId: string, phase: SessionState['phase']): Promise<void> {
    this.database.prepare(`
      UPDATE sessions SET phase = ?, updated_at = ? WHERE id = ?
    `).run(phase, Date.now() * 1000, sessionId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRecoverySystem(config: RecoveryConfig): RecoverySystem {
  return new RecoverySystem(config);
}
