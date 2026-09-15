/**
 * @oa/recovery — Core Types
 *
 * Recovery system types for crash recovery, stall detection, and checkpoint
 * management.
 */

import type { SessionState, SessionPhase } from '@oa/event-store';
import type { ParkReason } from '@oa/session-core';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { SessionState, SessionPhase, ParkReason };

// ---------------------------------------------------------------------------
// RecoveryConfig — global configuration for RecoverySystem
// ---------------------------------------------------------------------------

export interface RecoveryConfig {
  /** Event store instance for appending recovery events. */
  eventStore: import('@oa/event-store').IEventStore;
  /** Storage database manager. */
  database: import('@oa/storage').DatabaseManager;
  /** Session manager for session operations. */
  sessionManager: import('@oa/session-core').SessionManager;
  /** Projection engine for state reconstruction. */
  projectionEngine: import('@oa/projection').IProjectionEngine;
  /** Stall watchdog configuration. */
  stallWatchdog?: StallWatchdogConfig;
  /** Checkpoint manager configuration. */
  checkpoint?: CheckpointConfig;
  /** Auto-recover on startup (default: true). */
  autoRecover?: boolean;
}

// ---------------------------------------------------------------------------
// StallWatchdog types
// ---------------------------------------------------------------------------

export interface StallWatchdogConfig {
  /** Interval between stall checks in milliseconds (default: 5000). */
  checkIntervalMs: number;
  /** Threshold before a session is considered stalled in milliseconds (default: 90000). */
  stallThresholdMs: number;
  /** Maximum number of consecutive stalls before escalation (default: 3). */
  maxStalls: number;
  /** Auto-park stalled sessions (default: true). */
  autoPark: boolean;
  /** Emit events to event store on stall detection (default: true). */
  emitEvents: boolean;
}

export const DEFAULT_STALL_WATCHDOG_CONFIG: StallWatchdogConfig = {
  checkIntervalMs: 5000,
  stallThresholdMs: 90000,
  maxStalls: 3,
  autoPark: true,
  emitEvents: true,
};

export interface StallInfo {
  /** Session ID that is stalled. */
  sessionId: string;
  /** When the stall was first detected (microseconds). */
  detectedAt: number;
  /** How long the session has been stalled (microseconds). */
  stallDuration: number;
  /** The phase the session was in when stalled. */
  phase: SessionPhase;
  /** The last event seq before the stall. */
  lastEventSeq: number;
  /** The last event timestamp (microseconds). */
  lastEventTimestamp: number;
  /** Number of consecutive stalls. */
  consecutiveStalls: number;
  /** Whether the session was auto-parked. */
  autoParked: boolean;
}

export interface WatchHandle {
  /** Session ID being watched. */
  sessionId: string;
  /** Stop watching this session. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Checkpoint types
// ---------------------------------------------------------------------------

export interface CheckpointConfig {
  /** Maximum number of checkpoints per session (default: 50). */
  maxCheckpointsPerSession: number;
  /** Auto-create checkpoints before risky operations (default: true). */
  autoCheckpoint: boolean;
  /** Default TTL for auto-checkpoints in microseconds (default: 24h). */
  defaultTtlMicros: number;
  /** Prune expired checkpoints on startup (default: true). */
  pruneOnStartup: boolean;
}

export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  maxCheckpointsPerSession: 50,
  autoCheckpoint: true,
  defaultTtlMicros: 24 * 60 * 60 * 1_000_000, // 24 hours
  pruneOnStartup: true,
};

export interface Checkpoint {
  id: string;
  sessionId: string;
  atSeq: number;
  state: SessionState;
  timestamp: number;
  label?: string;
  expiresAt?: number;
  /** Whether this was an automatic checkpoint. */
  auto: boolean;
}

export interface CheckpointListItem {
  id: string;
  atSeq: number;
  timestamp: number;
  label?: string;
  expiresAt?: number;
  auto: boolean;
}

// ---------------------------------------------------------------------------
// RecoveryReport — result of a recovery operation
// ---------------------------------------------------------------------------

export interface RecoveryReport {
  /** When the recovery started (microseconds). */
  startedAt: number;
  /** When the recovery completed (microseconds). */
  completedAt: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Total sessions scanned. */
  sessionsScanned: number;
  /** Sessions successfully recovered. */
  sessionsRecovered: number;
  /** Sessions that were parked (in-flight at crash time). */
  sessionsParked: number;
  /** Sessions that were in error state. */
  sessionsInError: number;
  /** Sessions that were waiting/paused (survived restart). */
  sessionsResumed: number;
  /** Errors encountered during recovery. */
  errors: RecoveryError[];
  /** Detailed per-session results. */
  sessionResults: SessionRecoveryResult[];
}

export interface SessionRecoveryResult {
  sessionId: string;
  action: 'recovered' | 'parked' | 'resumed' | 'error' | 'skipped';
  previousPhase: SessionPhase;
  newPhase: SessionPhase;
  hadParkedState: boolean;
  error?: string;
}

export interface RecoveryError {
  sessionId: string;
  error: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Turn pause/resume types
// ---------------------------------------------------------------------------

export interface PausedTurn {
  sessionId: string;
  turnId: string;
  pausedAt: number;
  reason: string;
  /** The seq at which the turn was paused. */
  atSeq: number;
  /** Partial state at pause time. */
  partialState: SessionState;
}

// ---------------------------------------------------------------------------
// Recovery event payloads
// ---------------------------------------------------------------------------

export interface SessionRecoveredPayload {
  previousPhase: SessionPhase;
  newPhase: SessionPhase;
  hadParkedState: boolean;
  recoveryAction: string;
}

export interface SessionParkedPayload {
  reason: ParkReason;
  atSeq: number;
  turnPhase: string;
}

export interface SessionStallDetectedPayload {
  stallDuration: number;
  consecutiveStalls: number;
  phase: SessionPhase;
  autoParked: boolean;
}

export interface CheckpointCreatedPayload {
  checkpointId: string;
  atSeq: number;
  label?: string;
  auto: boolean;
}

export interface CheckpointRestoredPayload {
  checkpointId: string;
  restoredAtSeq: number;
  previousSeq: number;
}
