/**
 * @oa/recovery — Public Exports
 *
 * Crash recovery, stall detection, and checkpoint management for OvolveAgent.
 *
 * @example
 * ```ts
 * import { createRecoverySystem } from '@oa/recovery';
 * import { createEventStore } from '@oa/event-store';
 * import { createStorage } from '@oa/storage';
 * import { createSessionManager } from '@oa/session-core';
 * import { createProjectionEngine } from '@oa/projection';
 *
 * const storage = createStorage({ dbPath: './data/agent.db' });
 * const eventStore = createEventStore({ database: storage.database });
 * const sessionManager = createSessionManager({ ... });
 * const projectionEngine = createProjectionEngine({ ... });
 *
 * const recovery = createRecoverySystem({
 *   eventStore,
 *   database: storage.database,
 *   sessionManager,
 *   projectionEngine,
 * });
 *
 * // On startup:
 * const report = await recovery.recoverFromCrash();
 * console.log(`Recovered ${report.sessionsRecovered} sessions`);
 * ```
 */

// Types
export type {
  RecoveryConfig,
  RecoveryReport,
  SessionRecoveryResult,
  RecoveryError,
  StallWatchdogConfig,
  StallInfo,
  WatchHandle,
  CheckpointConfig,
  Checkpoint,
  CheckpointListItem,
  PausedTurn,
  SessionRecoveredPayload,
  SessionParkedPayload,
  SessionStallDetectedPayload,
  CheckpointCreatedPayload,
  CheckpointRestoredPayload,
} from './types';

export {
  DEFAULT_STALL_WATCHDOG_CONFIG,
  DEFAULT_CHECKPOINT_CONFIG,
} from './types';

// RecoverySystem
export {
  RecoverySystem,
  createRecoverySystem,
} from './recovery-system';

// StallWatchdog
export {
  StallWatchdog,
  createStallWatchdog,
  type StallWatchdogDependencies,
} from './stall-watchdog';

// CheckpointManager
export {
  CheckpointManager,
  createCheckpointManager,
  type CheckpointManagerConfig,
} from './checkpoint-manager';
