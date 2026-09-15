/**
 * @oa/goals — GoalManager
 *
 * Main goal management system providing CRUD operations and execution
 * orchestration for autonomous goals.
 *
 * Features:
 * - Create, list, get, update, delete goals
 * - Structured brief builder for goal context
 * - Execution scheduling with worker pool
 * - Cost cap enforcement ($5 default per goal)
 * - Stuck detection and recovery
 * - LLM-based completion verification
 * - Event emission for audit trail
 *
 * @example
 * ```ts
 * import { createGoalManager, createSimpleBrief } from '@oa/goals';
 *
 * const manager = createGoalManager({ scheduler: { maxWorkers: 2 } });
 *
 * // Create a goal
 * const goal = await manager.createGoal('Fix the login bug', {
 *   brief: createSimpleBrief('Fix the login bug', ['Login works with valid credentials']),
 * });
 *
 * // Execute the goal
 * await manager.getScheduler().executeGoalById(goal.id);
 * ```
 */

import type {
  Goal,
  GoalBrief,
  GoalConfig,
  GoalEvent,
  GoalStep,
  GoalStatus,
  SchedulerConfig,
  StuckConfig,
} from './types';
import {
  DEFAULT_GOAL_CONFIG,
  GoalStatus as Status,
} from './types';
import { GoalScheduler, createGoalScheduler } from './goal-scheduler';
import { createSimpleBrief } from './brief-builder';

// ---------------------------------------------------------------------------
// Create goal options
// ---------------------------------------------------------------------------

export interface CreateGoalOptions {
  /** Pre-built brief (or builder will create from description). */
  brief?: GoalBrief;
  /** Brief context. */
  context?: string;
  /** Constraints. */
  constraints?: string[];
  /** Success criteria. */
  successCriteria?: string[];
  /** Cost cap override (USD). */
  costCapUsd?: number;
  /** Max steps override. */
  maxSteps?: number;
  /** Priority (1-5). */
  priority?: number;
  /** Parent goal ID (for sub-goals). */
  parentId?: string;
  /** Resources. */
  resources?: string[];
  /** Notes. */
  notes?: string;
}

export interface UpdateGoalOptions {
  description?: string;
  brief?: Partial<GoalBrief>;
  status?: GoalStatus;
  priority?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// GoalManager
// ---------------------------------------------------------------------------

export class GoalManager {
  private readonly config: GoalConfig;
  private readonly goals: Map<string, Goal> = new Map();
  private readonly stepCallbacks: Map<string, (step: GoalStep) => void> = new Map();
  private readonly scheduler: GoalScheduler;
  private readonly eventHandlers: Set<(event: GoalEvent) => void> = new Set();

  constructor(config: Partial<GoalConfig> = {}) {
    this.config = { ...DEFAULT_GOAL_CONFIG, ...config };
    this.scheduler = createGoalScheduler(
      this.goals,
      this.stepCallbacks,
      this.config.scheduler,
      this.config.stuckConfig
    );

    // Forward scheduler events
    this.scheduler.onEvent((event) => {
      this.emit(event);
    });
  }

  // -------------------------------------------------------------------------
  // Event system
  // -------------------------------------------------------------------------

  /**
   * Subscribe to goal events.
   */
  onEvent(handler: (event: GoalEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: GoalEvent): void {
    if (!this.config.scheduler.emitEvents) return;
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Handlers must not break the manager
      }
    }
  }

  // -------------------------------------------------------------------------
  // CRUD operations
  // -------------------------------------------------------------------------

  /**
   * Create a new goal.
   *
   * @param description Short description of the goal.
   * @param options Goal creation options.
   * @returns The created goal.
   */
  createGoal(description: string, options: CreateGoalOptions = {}): Goal {
    const now = Date.now();
    const id = `goal_${now}_${Math.random().toString(36).slice(2, 10)}`;

    // Build the brief
    let brief: GoalBrief;
    if (options.brief) {
      brief = options.brief;
    } else if (options.successCriteria && options.successCriteria.length > 0) {
      brief = createSimpleBrief(description, options.successCriteria, {
        context: options.context,
        constraints: options.constraints,
        costCapUsd: options.costCapUsd ?? this.config.scheduler.defaultCostCapUsd,
        maxSteps: options.maxSteps ?? this.config.scheduler.defaultMaxSteps,
        priority: options.priority,
        resources: options.resources,
        notes: options.notes,
      });
    } else {
      // Create a minimal brief from description
      brief = createSimpleBrief(description, ['Task completed successfully'], {
        context: options.context,
        constraints: options.constraints,
        costCapUsd: options.costCapUsd ?? this.config.scheduler.defaultCostCapUsd,
        maxSteps: options.maxSteps ?? this.config.scheduler.defaultMaxSteps,
        priority: options.priority,
        resources: options.resources,
        notes: options.notes,
      });
    }

    // Apply overrides
    if (options.costCapUsd !== undefined) brief.costCapUsd = options.costCapUsd;
    if (options.maxSteps !== undefined) brief.maxSteps = options.maxSteps;
    if (options.priority !== undefined) brief.priority = options.priority;

    // Enforce max cost cap
    brief.costCapUsd = Math.min(brief.costCapUsd, this.config.scheduler.maxCostCapUsd);

    const goal: Goal = {
      id,
      description,
      brief,
      status: Status.PENDING,
      createdAt: now,
      updatedAt: now,
      steps: [],
      costIncurredUsd: 0,
      currentStep: 0,
      metadata: {
        llmCalls: 0,
        toolCalls: 0,
        totalTokens: 0,
        retries: 0,
        stuckDetections: 0,
      },
      parentId: options.parentId,
    };

    this.goals.set(id, goal);

    this.emit({
      type: 'goal:created',
      goalId: id,
      timestamp: now,
      data: { description, brief },
    });

    return goal;
  }

  /**
   * List goals, optionally filtered by status.
   *
   * @param status Optional status filter.
   */
  listGoals(status?: GoalStatus): Goal[] {
    const all = Array.from(this.goals.values());
    if (status) {
      return all.filter((g) => g.status === status);
    }
    return all;
  }

  /**
   * Get a goal by ID.
   *
   * @param id The goal ID.
   */
  getGoal(id: string): Goal | null {
    return this.goals.get(id) ?? null;
  }

  /**
   * Update a goal.
   *
   * @param id The goal ID.
   * @param updates The updates to apply.
   * @returns The updated goal, or null if not found.
   */
  updateGoal(id: string, updates: UpdateGoalOptions): Goal | null {
    const goal = this.goals.get(id);
    if (!goal) return null;

    if (updates.description !== undefined) {
      goal.description = updates.description;
    }
    if (updates.brief !== undefined) {
      goal.brief = { ...goal.brief, ...updates.brief };
    }
    if (updates.status !== undefined) {
      goal.status = updates.status;
      if (updates.status === Status.COMPLETED) {
        goal.completedAt = Date.now();
      }
    }
    if (updates.priority !== undefined) {
      goal.brief.priority = updates.priority;
    }
    if (updates.error !== undefined) {
      goal.error = updates.error;
    }

    goal.updatedAt = Date.now();

    return goal;
  }

  /**
   * Delete a goal.
   *
   * @param id The goal ID.
   * @returns True if the goal was deleted.
   */
  deleteGoal(id: string): boolean {
    const goal = this.goals.get(id);
    if (!goal) return false;

    // Cancel if running
    if (goal.status === Status.RUNNING || goal.status === Status.PAUSED) {
      this.scheduler.cancelGoal(id);
    }

    return this.goals.delete(id);
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Execute a goal by ID.
   *
   * @param goalId The goal ID to execute.
   * @returns True if the goal was enqueued.
   */
  executeGoalById(goalId: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status !== Status.PENDING) return false;

    this.scheduler.enqueue(goalId);
    return true;
  }

  /**
   * Pause a running goal.
   */
  pauseGoal(goalId: string): boolean {
    return this.scheduler.pauseGoal(goalId);
  }

  /**
   * Resume a paused goal.
   */
  resumeGoal(goalId: string): boolean {
    return this.scheduler.resumeGoal(goalId);
  }

  /**
   * Cancel a goal.
   */
  cancelGoal(goalId: string): boolean {
    return this.scheduler.cancelGoal(goalId);
  }

  /**
   * Register a step callback for a goal.
   */
  onStep(goalId: string, callback: (step: GoalStep) => void): void {
    this.stepCallbacks.set(goalId, callback);
  }

  // -------------------------------------------------------------------------
  // Scheduler access
  // -------------------------------------------------------------------------

  /**
   * Get the scheduler instance.
   */
  getScheduler(): GoalScheduler {
    return this.scheduler;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /**
   * Get goal manager statistics.
   */
  getStats(): {
    total: number;
    byStatus: Record<GoalStatus, number>;
    totalCost: number;
    scheduler: ReturnType<GoalScheduler['getStats']>;
  } {
    const all = Array.from(this.goals.values());
    const byStatus: Record<GoalStatus, number> = {
      [Status.PENDING]: 0,
      [Status.RUNNING]: 0,
      [Status.PAUSED]: 0,
      [Status.COMPLETED]: 0,
      [Status.FAILED]: 0,
      [Status.CANCELLED]: 0,
      [Status.COST_EXCEEDED]: 0,
      [Status.STUCK]: 0,
    };

    let totalCost = 0;
    for (const goal of all) {
      byStatus[goal.status]++;
      totalCost += goal.costIncurredUsd;
    }

    return {
      total: all.length,
      byStatus,
      totalCost,
      scheduler: this.scheduler.getStats(),
    };
  }

  /**
   * Shutdown the goal manager.
   */
  shutdown(): void {
    this.scheduler.shutdown();
    this.goals.clear();
    this.stepCallbacks.clear();
    this.eventHandlers.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a GoalManager instance.
 */
export function createGoalManager(config: Partial<GoalConfig> = {}): GoalManager {
  return new GoalManager(config);
}
