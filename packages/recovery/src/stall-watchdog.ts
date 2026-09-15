/**
 * @oa/recovery — Stall Watchdog
 *
 * Monitors active sessions for stalls — situations where a session has not
 * received new events for longer than the configured threshold. When a stall
 * is detected:
 * 1. A stall event is emitted to the event store (for audit trail).
 * 2. The stall count is incremented.
 * 3. If maxStalls is reached, the session is auto-parked (if configured).
 *
 * Design:
 * - Uses setInterval for periodic checking.
 * - Tracks last event timestamp per session.
 * - Emits events to the event store for audit trail.
 * - Configurable thresholds and intervals.
 */

import type { EventType, IEventStore } from '@oa/event-store';
import type { DatabaseManager } from '@oa/storage';
import type {
  StallWatchdogConfig,
  StallInfo,
  WatchHandle,
  SessionStallDetectedPayload,
} from './types';
import { DEFAULT_STALL_WATCHDOG_CONFIG } from './types';

// ---------------------------------------------------------------------------
// Internal watch state
// ---------------------------------------------------------------------------

interface WatchState {
  sessionId: string;
  lastEventTimestamp: number;
  lastEventSeq: number;
  lastCheckTimestamp: number;
  consecutiveStalls: number;
  firstStallTimestamp: number;
}

// ---------------------------------------------------------------------------
// StallWatchdog
// ---------------------------------------------------------------------------

export interface StallWatchdogDependencies {
  /** Event store for emitting stall events. */
  eventStore: IEventStore;
  /** Database manager for reading session state. */
  database: DatabaseManager;
  /** Callback invoked when a stall is detected. */
  onStall?: (info: StallInfo) => void;
  /** Callback invoked when a session should be auto-parked. */
  onAutoPark?: (sessionId: string, info: StallInfo) => void;
}

export class StallWatchdog {
  private readonly config: StallWatchdogConfig;
  private readonly eventStore: IEventStore;
  private readonly database: DatabaseManager;
  private readonly onStall?: (info: StallInfo) => void;
  private readonly onAutoPark?: (sessionId: string, info: StallInfo) => void;

  /** Active watches (sessionId -> watch state). */
  private readonly watches: Map<string, WatchState> = new Map();

  /** The global check interval handle. */
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Whether the watchdog is currently running. */
  private running: boolean = false;

  constructor(
    config: Partial<StallWatchdogConfig>,
    dependencies: StallWatchdogDependencies
  ) {
    this.config = { ...DEFAULT_STALL_WATCHDOG_CONFIG, ...config };
    this.eventStore = dependencies.eventStore;
    this.database = dependencies.database;
    this.onStall = dependencies.onStall;
    this.onAutoPark = dependencies.onAutoPark;
  }

  // -------------------------------------------------------------------------
  // Watch management
  // -------------------------------------------------------------------------

  /**
   * Start monitoring a session for stalls. The watchdog tracks the session's
   * last event timestamp and checks it periodically.
   *
   * @param sessionId - The session to monitor.
   */
  watch(sessionId: string): void {
    if (this.watches.has(sessionId)) return; // Already watching

    const now = Date.now() * 1000;
    this.watches.set(sessionId, {
      sessionId,
      lastEventTimestamp: now,
      lastEventSeq: 0,
      lastCheckTimestamp: now,
      consecutiveStalls: 0,
      firstStallTimestamp: 0,
    });

    // Start the global interval if not already running
    this.start();
  }

  /**
   * Stop monitoring a session.
   *
   * @param sessionId - The session to stop monitoring.
   */
  unwatch(sessionId: string): void {
    this.watches.delete(sessionId);

    // Stop the global interval if no more watches
    if (this.watches.size === 0) {
      this.stop();
    }
  }

  /**
   * Update the last event timestamp for a session (called when a new event
   * is appended). This resets the stall detection for that session.
   *
   * @param sessionId - The session ID.
   * @param timestamp - The event timestamp.
   * @param seq - The event seq.
   */
  updateActivity(sessionId: string, timestamp: number, seq: number): void {
    const watch = this.watches.get(sessionId);
    if (!watch) return;

    watch.lastEventTimestamp = timestamp;
    watch.lastEventSeq = seq;
    watch.lastCheckTimestamp = Date.now() * 1000;

    // Reset stall count on new activity
    if (watch.consecutiveStalls > 0) {
      watch.consecutiveStalls = 0;
      watch.firstStallTimestamp = 0;
    }
  }

  /**
   * Check a specific session for stall conditions. Called automatically by
   * the periodic checker, but can also be called manually.
   *
   * @param sessionId - The session to check.
   * @returns StallInfo if stalled, null otherwise.
   */
  check(sessionId: string): StallInfo | null {
    const watch = this.watches.get(sessionId);
    if (!watch) return null;

    const now = Date.now() * 1000;
    const stallDuration = now - watch.lastEventTimestamp;
    watch.lastCheckTimestamp = now;

    // Check if the session has exceeded the stall threshold
    if (stallDuration < this.config.stallThresholdMs * 1000) {
      return null; // Not stalled
    }

    // Stall detected
    if (watch.consecutiveStalls === 0) {
      watch.firstStallTimestamp = now;
    }
    watch.consecutiveStalls++;

    // Get current phase from the session record
    const phase = this.getSessionPhase(sessionId);

    const info: StallInfo = {
      sessionId,
      detectedAt: watch.firstStallTimestamp,
      stallDuration,
      phase,
      lastEventSeq: watch.lastEventSeq,
      lastEventTimestamp: watch.lastEventTimestamp,
      consecutiveStalls: watch.consecutiveStalls,
      autoParked: false,
    };

    // Emit event to event store
    if (this.config.emitEvents) {
      this.emitStallEvent(info);
    }

    // Invoke callback
    this.onStall?.(info);

    // Auto-park if max stalls reached
    if (this.config.autoPark && watch.consecutiveStalls >= this.config.maxStalls) {
      info.autoParked = true;
      this.onAutoPark?.(sessionId, info);
    }

    return info;
  }

  /**
   * Check all watched sessions for stalls.
   *
   * @returns Array of stall info for all stalled sessions.
   */
  checkAll(): StallInfo[] {
    const stalls: StallInfo[] = [];
    for (const sessionId of this.watches.keys()) {
      const info = this.check(sessionId);
      if (info) stalls.push(info);
    }
    return stalls;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the periodic stall checker.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.intervalHandle = setInterval(() => {
      this.checkAll();
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the periodic stall checker.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.running = false;
  }

  /**
   * Check if the watchdog is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of sessions being watched.
   */
  getWatchCount(): number {
    return this.watches.size;
  }

  /**
   * Get the list of watched session IDs.
   */
  getWatchedSessions(): string[] {
    return Array.from(this.watches.keys());
  }

  /**
   * Get the watch state for a session (for inspection).
   */
  getWatchState(sessionId: string): Readonly<WatchState> | null {
    return this.watches.get(sessionId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private getSessionPhase(sessionId: string): import('@oa/event-store').SessionPhase {
    const row = this.database.prepare(
      'SELECT phase FROM sessions WHERE id = ?'
    ).get(sessionId) as { phase: string } | undefined;
    return (row?.phase ?? 'idle') as import('@oa/event-store').SessionPhase;
  }

  private async emitStallEvent(info: StallInfo): Promise<void> {
    const payload: SessionStallDetectedPayload = {
      stallDuration: info.stallDuration,
      consecutiveStalls: info.consecutiveStalls,
      phase: info.phase,
      autoParked: info.autoParked,
    };

    try {
      await this.eventStore.append({
        eventType: EventType.AgentErrorOccurred,
        sessionId: info.sessionId,
        payload,
      });
    } catch {
      // Event emission should not break the watchdog
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStallWatchdog(
  config: Partial<StallWatchdogConfig>,
  dependencies: StallWatchdogDependencies
): StallWatchdog {
  return new StallWatchdog(config, dependencies);
}
