/**
 * @oa/goals — Public Exports
 *
 * Autonomous goal execution system with structured briefs, cost caps,
 * stuck detection, and machine verification.
 *
 * @example
 * ```ts
 * import { createGoalManager, createSimpleBrief, GoalStatus } from '@oa/goals';
 *
 * const manager = createGoalManager({
 *   scheduler: { maxWorkers: 2, defaultCostCapUsd: 5 },
 * });
 *
 * // Create a goal
 * const goal = manager.createGoal('Fix the login bug', {
 *   successCriteria: ['Login works with valid credentials', 'Error handling is robust'],
 * });
 *
 * // Execute
 * manager.executeGoalById(goal.id);
 *
 * // Monitor
 * manager.onEvent((event) => {
 *   console.log(`Goal ${event.goalId}: ${event.type}`);
 * });
 * ```
 */

// Types
export {
  GoalStatus,
  type Goal,
  type GoalBrief,
  type GoalStep,
  type GoalMetadata,
  type GoalVerificationResult,
  type StuckState,
  type StuckConfig,
  type SchedulerConfig,
  type GoalConfig,
  type GoalAgentLoopFactory,
  type GoalEvent,
  DEFAULT_STUCK_CONFIG,
  DEFAULT_SCHEDULER_CONFIG,
  DEFAULT_GOAL_CONFIG,
} from './types';

// Manager
export {
  GoalManager,
  createGoalManager,
  type CreateGoalOptions,
  type UpdateGoalOptions,
} from './goal-manager';

// Scheduler
export {
  GoalScheduler,
  createGoalScheduler,
  type GoalEventHandler,
} from './goal-scheduler';

// Brief builder
export {
  GoalBriefBuilder,
  createBriefBuilder,
  createSimpleBrief,
  createTaskBrief,
  formatBriefAsString,
} from './brief-builder';

// Verifier
export {
  verifyGoalCompletion,
  quickVerify,
  type VerifierConfig,
} from './verifier';

// Stuck detector
export {
  StuckDetector,
  createStuckDetector,
  computeActionSignature,
  type StuckAnalysisResult,
} from './stuck-detector';
