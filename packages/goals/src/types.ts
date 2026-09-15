/**
 * @oa/goals — Core Types
 *
 * Autonomous goal execution system with structured briefs, cost caps,
 * stuck detection, and machine verification.
 *
 * Goals are high-level objectives that the agent breaks down into
 * actionable steps and executes autonomously. Each goal has:
 * - A structured brief (context, constraints, success criteria)
 * - A cost cap (maximum spend in USD)
 * - Stuck detection (loop prevention)
 * - Machine verification (LLM-based completion check)
 */

// ---------------------------------------------------------------------------
// Goal status
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a goal.
 */
export enum GoalStatus {
  /** Goal created but not yet started. */
  PENDING = 'PENDING',
  /** Goal is actively being executed. */
  RUNNING = 'RUNNING',
  /** Goal execution paused by user. */
  PAUSED = 'PAUSED',
  /** Goal completed successfully. */
  COMPLETED = 'COMPLETED',
  /** Goal failed (error, timeout, or stuck). */
  FAILED = 'FAILED',
  /** Goal cancelled by user. */
  CANCELLED = 'CANCELLED',
  /** Goal exceeded cost cap. */
  COST_EXCEEDED = 'COST_EXCEEDED',
  /** Goal detected as stuck. */
  STUCK = 'STUCK',
}

// ---------------------------------------------------------------------------
// Goal brief
// ---------------------------------------------------------------------------

/**
 * A structured goal brief — the full context for goal execution.
 */
export interface GoalBrief {
  /** The high-level objective. */
  objective: string;
  /** Background context for the goal. */
  context: string;
  /** Constraints and limitations. */
  constraints: string[];
  /** Success criteria — how to know the goal is complete. */
  successCriteria: string[];
  /** Preferred tools or approaches. */
  preferredApproaches?: string[];
  /** Maximum execution steps. */
  maxSteps: number;
  /** Maximum cost in USD. */
  costCapUsd: number;
  /** Priority level (1-5, 5 = highest). */
  priority: number;
  /** Related files or resources. */
  resources?: string[];
  /** Additional notes. */
  notes?: string;
}

/**
 * A goal entity.
 */
export interface Goal {
  /** Unique goal ID. */
  id: string;
  /** Short description of the goal. */
  description: string;
  /** Structured brief. */
  brief: GoalBrief;
  /** Current status. */
  status: GoalStatus;
  /** Creation timestamp. */
  createdAt: number;
  /** Last update timestamp. */
  updatedAt: number;
  /** Completion timestamp. */
  completedAt?: number;
  /** Execution steps taken. */
  steps: GoalStep[];
  /** Total cost incurred (USD). */
  costIncurredUsd: number;
  /** Current step index. */
  currentStep: number;
  /** Error message if failed. */
  error?: string;
  /** Verification result. */
  verificationResult?: GoalVerificationResult;
  /** Execution metadata. */
  metadata: GoalMetadata;
  /** Parent goal ID (for sub-goals). */
  parentId?: string;
  /** Child goal IDs. */
  childIds?: string[];
}

/**
 * A single step in goal execution.
 */
export interface GoalStep {
  /** Step index. */
  index: number;
  /** Action taken. */
  action: string;
  /** Tool used (if any). */
  toolName?: string;
  /** Result of the action. */
  result: string;
  /** Whether the step succeeded. */
  success: boolean;
  /** Step duration in ms. */
  durationMs: number;
  /** Timestamp. */
  timestamp: number;
  /** Token usage for this step. */
  tokenUsage?: {
    prompt: number;
    completion: number;
    costUsd: number;
  };
}

/**
 * Execution metadata for a goal.
 */
export interface GoalMetadata {
  /** Number of LLM calls made. */
  llmCalls: number;
  /** Number of tool calls made. */
  toolCalls: number;
  /** Total tokens consumed. */
  totalTokens: number;
  /** Number of retries. */
  retries: number;
  /** Stuck detection count. */
  stuckDetections: number;
  /** Execution session ID. */
  sessionId?: string;
  /** Custom metadata. */
  custom?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Result of goal completion verification.
 */
export interface GoalVerificationResult {
  /** Whether the goal is verified complete. */
  verified: boolean;
  /** Confidence score (0-1). */
  confidence: number;
  /** Reasoning for the verification decision. */
  reasoning: string;
  /** Missing criteria (if not verified). */
  missingCriteria?: string[];
  /** Verification timestamp. */
  timestamp: number;
  /** Model used for verification. */
  modelUsed: string;
}

// ---------------------------------------------------------------------------
// Stuck detection
// ---------------------------------------------------------------------------

/**
 * Stuck loop detection state.
 */
export interface StuckState {
  /** Recent action signatures. */
  recentActions: string[];
  /** Count of consecutive same-action repeats. */
  sameActionCount: number;
  /** Last action signature. */
  lastActionSignature: string;
  /** Distinct signatures in current window. */
  distinctSignatures: Set<string>;
  /** Window start index. */
  windowStart: number;
  /** Whether currently detected as stuck. */
  isStuck: boolean;
  /** Timestamp of last stuck detection. */
  lastStuckAt?: number;
}

/**
 * Stuck detection configuration.
 */
export interface StuckConfig {
  /** Max consecutive same-action repeats before stuck. */
  maxSameActionRepeats: number;
  /** Window size for distinct signature check. */
  stuckWindow: number;
  /** Max distinct signatures in window before considered stuck. */
  distinctMax: number;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Scheduler configuration.
 */
export interface SchedulerConfig {
  /** Maximum concurrent goal executions (workers). */
  maxWorkers: number;
  /** Default cost cap per goal (USD). */
  defaultCostCapUsd: number;
  /** Maximum cost cap allowed (USD). */
  maxCostCapUsd: number;
  /** Default max steps per goal. */
  defaultMaxSteps: number;
  /** Goal execution timeout (ms). */
  goalTimeoutMs: number;
  /** Whether to enable stuck detection. */
  enableStuckDetection: boolean;
  /** Whether to enable machine verification. */
  enableVerification: boolean;
  /** LLM model for verification. */
  verificationModel: string;
  /** Whether to emit events for audit trail. */
  emitEvents: boolean;
}

// ---------------------------------------------------------------------------
// Goal configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the GoalManager.
 */
export interface GoalConfig {
  /** Scheduler configuration. */
  scheduler: SchedulerConfig;
  /** LLM client for verification. */
  llmClient?: import('@oa/llm').LlmClient;
  /** Agent loop factory for execution. */
  agentLoopFactory?: GoalAgentLoopFactory;
  /** Stuck detection config. */
  stuckConfig: StuckConfig;
  /** Whether to persist goals to storage. */
  persistGoals: boolean;
  /** Storage path for persisted goals. */
  storagePath?: string;
}

/**
 * Factory function that creates an agent loop for goal execution.
 */
export type GoalAgentLoopFactory = (goal: Goal, options: {
  onStep: (step: GoalStep) => void;
  onComplete: (result: GoalVerificationResult) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
}) => {
  execute: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type GoalEventType =
  | 'goal:created'
  | 'goal:started'
  | 'goal:step'
  | 'goal:completed'
  | 'goal:failed'
  | 'goal:paused'
  | 'goal:resumed'
  | 'goal:cancelled'
  | 'goal:stuck'
  | 'goal:verified'
  | 'goal:cost_exceeded';

export interface GoalEvent {
  type: GoalEventType;
  goalId: string;
  timestamp: number;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Default configurations
// ---------------------------------------------------------------------------

export const DEFAULT_STUCK_CONFIG: StuckConfig = {
  maxSameActionRepeats: 3,
  stuckWindow: 4,
  distinctMax: 2,
};

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxWorkers: 2,
  defaultCostCapUsd: 5,
  maxCostCapUsd: 20,
  defaultMaxSteps: 25,
  goalTimeoutMs: 600_000, // 10 minutes
  enableStuckDetection: true,
  enableVerification: true,
  verificationModel: 'gpt-4o-mini',
  emitEvents: true,
};

export const DEFAULT_GOAL_CONFIG: GoalConfig = {
  scheduler: DEFAULT_SCHEDULER_CONFIG,
  stuckConfig: DEFAULT_STUCK_CONFIG,
  persistGoals: false,
};
