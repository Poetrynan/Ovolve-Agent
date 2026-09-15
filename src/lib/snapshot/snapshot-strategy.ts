/**
 * Snapshot Strategy & Policy — DeepSeek Architecture
 * Configures snapshot cadences, compaction boundaries, memory pruning, and rollbacks.
 */

import { DeltaSnapshot, DeltaNode, DeltaSnapshotBuilder } from './delta-snapshot';

export interface SnapshotStrategyConfig {
  /** Checkpoint cadence in terms of conversation turns (default: every 2 turns) */
  autoSnapshotTurnInterval: number;
  /** Maximum number of rolling snapshots retained in memory (default: 20) */
  maxRetainedSnapshots: number;
  /** Automatically take full checkpoint when tool batch completes */
  checkpointOnToolBatchEnd: boolean;
  /** Automatically take full checkpoint before and after context compaction */
  checkpointOnCompaction: boolean;
  /** Compression threshold in token count (default: 32k) */
  compactionTokenThreshold: number;
}

export const DEFAULT_SNAPSHOT_STRATEGY_CONFIG: SnapshotStrategyConfig = {
  autoSnapshotTurnInterval: 2,
  maxRetainedSnapshots: 20,
  checkpointOnToolBatchEnd: true,
  checkpointOnCompaction: true,
  compactionTokenThreshold: 32_000,
};

export interface CheckpointRecord {
  id: string;
  revision: number;
  turn: number;
  snapshot: DeltaSnapshot;
  description: string;
  createdAt: number;
}

/**
 * Snapshot Strategy Manager
 */
export class SnapshotStrategyManager {
  private config: SnapshotStrategyConfig;
  private readonly builder: DeltaSnapshotBuilder;
  private checkpoints: CheckpointRecord[] = [];

  constructor(config: Partial<SnapshotStrategyConfig> = {}) {
    this.config = { ...DEFAULT_SNAPSHOT_STRATEGY_CONFIG, ...config };
    this.builder = new DeltaSnapshotBuilder();
  }

  getConfig(): SnapshotStrategyConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<SnapshotStrategyConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Take a checkpoint snapshot with auto-pruning
   */
  createCheckpoint(nodes: DeltaNode[], turn: number, description: string): CheckpointRecord {
    const snapshot = this.builder.replace(nodes);
    const checkpoint: CheckpointRecord = {
      id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      revision: snapshot.revision,
      turn,
      snapshot,
      description,
      createdAt: Date.now(),
    };

    this.checkpoints.push(checkpoint);

    // Prune old snapshots exceeding maximum retention
    if (this.checkpoints.length > this.config.maxRetainedSnapshots) {
      this.checkpoints = this.checkpoints.slice(-this.config.maxRetainedSnapshots);
    }

    return checkpoint;
  }

  /**
   * List all stored checkpoints
   */
  listCheckpoints(): readonly CheckpointRecord[] {
    return this.checkpoints;
  }

  /**
   * Rollback to a specific checkpoint by ID
   */
  rollbackToCheckpoint(checkpointId: string): DeltaSnapshot | undefined {
    const target = this.checkpoints.find((c) => c.id === checkpointId);
    if (!target) return undefined;

    // Prune checkpoints created after this one
    const idx = this.checkpoints.indexOf(target);
    this.checkpoints = this.checkpoints.slice(0, idx + 1);

    return target.snapshot;
  }
}
