/**
 * @oa/goals — Goal Execution Scheduler
 *
 * Manages the execution of goals with:
 * - Max workers: 2 concurrent goal executions
 * - Cost cap: $5 per goal (configurable)
 * - Pause/resume/cancel support
 * - Stuck detection integration
 *
 * The scheduler uses a worker pool pattern where each worker handles
 * one goal at a time. When a worker finishes, it picks up the next
 * pending goal from the queue.
 */

import type {
  Goal,
  GoalEvent,
  GoalStep,
  SchedulerConfig,
  StuckConfig,
} from './types';
import {
  DEFAULT_SCHEDULER_CONFIG,
  DEFAULT_STUCK_CONFIG,
  GoalStatus,
} from './types';
import { StuckDetector, createStuckDetector } from './stuck-detector';

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

export type GoalEventHandler = (event: GoalEvent) => void;

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

interface WorkerState {
  goalId: string;
  abortController: AbortController;
  detector: StuckDetector;
  paused: boolean;
  pauseResolve?: () => void;
}

// ---------------------------------------------------------------------------
// GoalScheduler
// ---------------------------------------------------------------------------

export class GoalScheduler {
  private readonly config: SchedulerConfig;
  private readonly stuckConfig: StuckConfig;
  private readonly eventHandlers: Set<GoalEventHandler> = new Set();
  private readonly workers: Map<number, WorkerState> = new Map();
  private readonly goalQueue: string[] = [];
  private readonly goalStore: Map<string, Goal>;
  private readonly stepCallbacks: Map<string, (step: GoalStep) => void>;
  private isShutdown = false;

  constructor(
    goalStore: Map<string, Goal>,
    stepCallbacks: Map<string, (step: GoalStep) => void>,
    config: Partial<SchedulerConfig> = {},
    stuckConfig: Partial<StuckConfig> = {}
  ) {
    this.goalStore = goalStore;
    this.stepCallbacks = stepCallbacks;
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.stuckConfig = { ...DEFAULT_STUCK_CONFIG, ...stuckConfig };
  }

  // -------------------------------------------------------------------------
  // Event system
  // -------------------------------------------------------------------------

  /**
   * Subscribe to goal events.
   */
  onEvent(handler: GoalEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: GoalEvent): void {
    if (!this.config.emitEvents) return;
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Handlers must not break the scheduler
      }
    }
  }

  // -------------------------------------------------------------------------
  // Queue management
  // -------------------------------------------------------------------------

  /**
   * Enqueue a goal for execution.
   *
   * @param goalId The goal ID to enqueue.
   */
  enqueue(goalId: string): void {
    if (this.isShutdown) return;
    if (this.goalQueue.includes(goalId)) return;

    const goal = this.goalStore.get(goalId);
    if (!goal || goal.status !== GoalStatus.PENDING) return;

    this.goalQueue.push(goalId);
    this.processQueue();
  }

  /**
   * Get the current queue.
   */
  getQueue(): string[] {
    return [...this.goalQueue];
  }

  /**
   * Get active workers.
   */
  getActiveWorkers(): number {
    return this.workers.size;
  }

  /**
   * Check if a goal is currently being executed.
   */
  isExecuting(goalId: string): boolean {
    for (const worker of this.workers.values()) {
      if (worker.goalId === goalId) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Process the queue — assign goals to available workers.
   */
  private processQueue(): void {
    if (this.isShutdown) return;

    while (this.goalQueue.length > 0 && this.workers.size < this.config.maxWorkers) {
      const goalId = this.goalQueue.shift()!;
      const goal = this.goalStore.get(goalId);

      if (!goal || goal.status !== GoalStatus.PENDING) continue;

      // Find available worker slot
      const slot = this.findAvailableSlot();
      if (slot === -1) {
        // No slots available — put back in queue
        this.goalQueue.unshift(goalId);
        break;
      }

      // Start execution
      this.executeGoal(goalId, slot);
    }
  }

  /**
   * Find an available worker slot.
   */
  private findAvailableSlot(): number {
    for (let i = 0; i < this.config.maxWorkers; i++) {
      if (!this.workers.has(i)) return i;
    }
    return -1;
  }

  /**
   * Execute a goal in a worker slot.
   */
  private async executeGoal(goalId: string, slot: number): Promise<void> {
    const goal = this.goalStore.get(goalId);
    if (!goal) return;

    // Update goal status
    goal.status = GoalStatus.RUNNING;
    goal.updatedAt = Date.now();

    const abortController = new AbortController();
    const detector = createStuckDetector(this.stuckConfig);

    const workerState: WorkerState = {
      goalId,
      abortController,
      detector,
      paused: false,
    };

    this.workers.set(slot, workerState);

    this.emit({
      type: 'goal:started',
      goalId,
      timestamp: Date.now(),
      data: { slot, objective: goal.brief.objective },
    });

    try {
      // Execute the goal
      await this.runGoalExecution(goal, workerState);

      // Check if cancelled
      if (abortController.signal.aborted) {
        goal.status = GoalStatus.CANCELLED;
        goal.updatedAt = Date.now();
        this.emit({
          type: 'goal:cancelled',
          goalId,
          timestamp: Date.now(),
          data: { reason: 'Aborted' },
        });
        return;
      }

      // Verify completion
      if (this.config.enableVerification) {
        await this.verifyGoal(goal);
      } else {
        // Mark as completed without verification
        goal.status = GoalStatus.COMPLETED;
        goal.completedAt = Date.now();
        goal.updatedAt = Date.now();
      }
    } catch (error) {
      if (goal.status === GoalStatus.CANCELLED) return;

      goal.status = GoalStatus.FAILED;
      goal.error = error instanceof Error ? error.message : 'Unknown error';
      goal.updatedAt = Date.now();

      this.emit({
        type: 'goal:failed',
        goalId,
        timestamp: Date.now(),
        data: { error: goal.error },
      });
    } finally {
      this.workers.delete(slot);
      // Process next in queue
      this.processQueue();
    }
  }

  /**
   * Run the actual goal execution logic.
   *
   * This is a simplified execution that simulates agentic steps.
   * In production, this would integrate with AgentLoop for real execution.
   */
  private async runGoalExecution(goal: Goal, worker: WorkerState): Promise<void> {
    const signal = worker.abortController.signal;

    for (let step = 0; step < goal.brief.maxSteps; step++) {
      // Check abort
      if (signal.aborted) return;

      // Handle pause
      if (worker.paused) {
        await this.waitForResume(worker);
        if (signal.aborted) return;
      }

      // Check cost cap
      if (goal.costIncurredUsd >= goal.brief.costCapUsd) {
        goal.status = GoalStatus.COST_EXCEEDED;
        goal.updatedAt = Date.now();
        this.emit({
          type: 'goal:cost_exceeded',
          goalId: goal.id,
          timestamp: Date.now(),
          data: { cost: goal.costIncurredUsd, cap: goal.brief.costCapUsd },
        });
        return;
      }

      // Execute a step (placeholder — real execution would call AgentLoop)
      const stepResult = await this.executeStep(goal, step, signal);
      goal.steps.push(stepResult);
      goal.currentStep = step + 1;
      goal.updatedAt = Date.now();

      // Update cost
      if (stepResult.tokenUsage) {
        goal.costIncurredUsd += stepResult.tokenUsage.costUsd;
        goal.metadata.totalTokens += stepResult.tokenUsage.prompt + stepResult.tokenUsage.completion;
        goal.metadata.llmCalls++;
      }
      if (stepResult.toolName) {
        goal.metadata.toolCalls++;
      }

      // Notify step callback
      const callback = this.stepCallbacks.get(goal.id);
      if (callback) callback(stepResult);

      // Emit step event
      this.emit({
        type: 'goal:step',
        goalId: goal.id,
        timestamp: Date.now(),
        data: { step: stepResult },
      });

      // Stuck detection
      if (this.config.enableStuckDetection) {
        const isStuck = worker.detector.recordAndCheck(stepResult);
        if (isStuck) {
          goal.status = GoalStatus.STUCK;
          goal.metadata.stuckDetections++;
          goal.updatedAt = Date.now();

          const reason = worker.detector.getStuckReason() ?? 'Unknown';
          this.emit({
            type: 'goal:stuck',
            goalId: goal.id,
            timestamp: Date.now(),
            data: { reason, step: step + 1 },
          });

          // Try to recover by pausing
          goal.status = GoalStatus.PAUSED;
          return;
        }
      }

      // Check if goal is complete (heuristic)
      if (stepResult.success && stepResult.action.toLowerCase().includes('complete')) {
        return; // Goal appears complete
      }
    }
  }

  /**
   * Execute a single step (placeholder for real AgentLoop integration).
   */
  private async executeStep(
    goal: Goal,
    stepIndex: number,
    signal: AbortSignal
  ): Promise<GoalStep> {
    const startTime = Date.now();

    // In production, this would:
    // 1. Assemble context with goal brief
    // 2. Call AgentLoop for one step
    // 3. Parse the result

    // Simulated step execution
    const action = `Step ${stepIndex + 1}: Working on ${goal.brief.objective.slice(0, 50)}`;

    // Check abort
    if (signal.aborted) {
      return {
        index: stepIndex,
        action,
        result: 'Cancelled',
        success: false,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      };
    }

    return {
      index: stepIndex,
      action,
      result: `Progress made on step ${stepIndex + 1}`,
      success: true,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
      tokenUsage: {
        prompt: 100,
        completion: 50,
        costUsd: 0.003,
      },
    };
  }

  /**
   * Wait for a paused worker to resume.
   */
  private async waitForResume(worker: WorkerState): Promise<void> {
    return new Promise<void>((resolve) => {
      worker.pauseResolve = resolve;

      // Also listen for abort
      worker.abortController.signal.addEventListener('abort', () => {
        resolve();
      });
    });
  }

  /**
   * Verify goal completion using LLM.
   */
  private async verifyGoal(goal: Goal): Promise<void> {
    // In production, this would use the configured LLM client
    // For now, use a heuristic check
    const successRate = goal.steps.length > 0
      ? goal.steps.filter((s) => s.success).length / goal.steps.length
      : 0;

    const verified = successRate >= 0.7;

    goal.verificationResult = {
      verified,
      confidence: successRate,
      reasoning: verified
        ? 'Goal appears complete based on execution results'
        : 'Goal may not be fully complete — success rate below threshold',
      missingCriteria: verified ? [] : goal.brief.successCriteria.filter((_, i) => i === 0),
      timestamp: Date.now(),
      modelUsed: this.config.verificationModel,
    };

    if (verified) {
      goal.status = GoalStatus.COMPLETED;
      goal.completedAt = Date.now();
      this.emit({
        type: 'goal:completed',
        goalId: goal.id,
        timestamp: Date.now(),
        data: { verification: goal.verificationResult },
      });
    } else {
      goal.status = GoalStatus.FAILED;
      goal.error = 'Verification failed';
      this.emit({
        type: 'goal:failed',
        goalId: goal.id,
        timestamp: Date.now(),
        data: { verification: goal.verificationResult },
      });
    }

    this.emit({
      type: 'goal:verified',
      goalId: goal.id,
      timestamp: Date.now(),
      data: { result: goal.verificationResult },
    });
  }

  // -------------------------------------------------------------------------
  // Goal control
  // -------------------------------------------------------------------------

  /**
   * Execute a goal immediately (adds to queue and processes).
   */
  executeGoalById(goalId: string): void {
    this.enqueue(goalId);
  }

  /**
   * Pause a running goal.
   */
  pauseGoal(goalId: string): boolean {
    const worker = this.findWorkerForGoal(goalId);
    if (!worker) return false;

    worker.paused = true;

    const goal = this.goalStore.get(goalId);
    if (goal) {
      goal.status = GoalStatus.PAUSED;
      goal.updatedAt = Date.now();
    }

    this.emit({
      type: 'goal:paused',
      goalId,
      timestamp: Date.now(),
      data: {},
    });

    return true;
  }

  /**
   * Resume a paused goal.
   */
  resumeGoal(goalId: string): boolean {
    const worker = this.findWorkerForGoal(goalId);
    if (!worker || !worker.paused) return false;

    worker.paused = false;
    if (worker.pauseResolve) {
      worker.pauseResolve();
      worker.pauseResolve = undefined;
    }

    const goal = this.goalStore.get(goalId);
    if (goal) {
      goal.status = GoalStatus.RUNNING;
      goal.updatedAt = Date.now();
    }

    this.emit({
      type: 'goal:resumed',
      goalId,
      timestamp: Date.now(),
      data: {},
    });

    return true;
  }

  /**
   * Cancel a goal (running or queued).
   */
  cancelGoal(goalId: string): boolean {
    // Remove from queue if pending
    const queueIndex = this.goalQueue.indexOf(goalId);
    if (queueIndex !== -1) {
      this.goalQueue.splice(queueIndex, 1);
      const goal = this.goalStore.get(goalId);
      if (goal) {
        goal.status = GoalStatus.CANCELLED;
        goal.updatedAt = Date.now();
      }
      this.emit({
        type: 'goal:cancelled',
        goalId,
        timestamp: Date.now(),
        data: { reason: 'Removed from queue' },
      });
      return true;
    }

    // Abort if running
    const worker = this.findWorkerForGoal(goalId);
    if (worker) {
      worker.abortController.abort();
      return true;
    }

    return false;
  }

  /**
   * Find the worker executing a goal.
   */
  private findWorkerForGoal(goalId: string): WorkerState | undefined {
    for (const worker of this.workers.values()) {
      if (worker.goalId === goalId) return worker;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Shutdown the scheduler — cancel all running goals.
   */
  shutdown(): void {
    this.isShutdown = true;

    // Abort all workers
    for (const worker of this.workers.values()) {
      worker.abortController.abort();
    }

    this.workers.clear();
    this.goalQueue.length = 0;
  }

  /**
   * Get scheduler statistics.
   */
  getStats(): {
    activeWorkers: number;
    maxWorkers: number;
    queueLength: number;
    isShutdown: boolean;
  } {
    return {
      activeWorkers: this.workers.size,
      maxWorkers: this.config.maxWorkers,
      queueLength: this.goalQueue.length,
      isShutdown: this.isShutdown,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a GoalScheduler instance.
 */
export function createGoalScheduler(
  goalStore: Map<string, Goal>,
  stepCallbacks: Map<string, (step: GoalStep) => void>,
  config: Partial<SchedulerConfig> = {},
  stuckConfig: Partial<StuckConfig> = {}
): GoalScheduler {
  return new GoalScheduler(goalStore, stepCallbacks, config, stuckConfig);
}
