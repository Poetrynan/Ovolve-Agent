/**
 * @oa/goals — Stuck Loop Detection
 *
 * Detects when goal execution is stuck in a loop by monitoring:
 * 1. Same action repeats: If the same action is repeated N times consecutively.
 * 2. Stuck window: In a window of N rounds, if only M distinct signatures appear.
 *
 * Default thresholds:
 * - Max same action repeats: 3
 * - Stuck window: 4 rounds
 * - Distinct max: 2 signatures
 *
 * When stuck is detected, the goal is paused and the user is notified.
 */

import type { GoalStep, StuckState, StuckConfig } from './types';
import { DEFAULT_STUCK_CONFIG } from './types';

// ---------------------------------------------------------------------------
// StuckDetector
// ---------------------------------------------------------------------------

export class StuckDetector {
  private readonly config: StuckConfig;
  private state: StuckState;

  constructor(config: Partial<StuckConfig> = {}) {
    this.config = { ...DEFAULT_STUCK_CONFIG, ...config };
    this.state = this.createInitialState();
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  /**
   * Create initial stuck state.
   */
  private createInitialState(): StuckState {
    return {
      recentActions: [],
      sameActionCount: 0,
      lastActionSignature: '',
      distinctSignatures: new Set(),
      windowStart: 0,
      isStuck: false,
    };
  }

  /**
   * Reset the detector state.
   */
  reset(): void {
    this.state = this.createInitialState();
  }

  /**
   * Get the current state (for inspection).
   */
  getState(): Readonly<StuckState> {
    return { ...this.state, distinctSignatures: new Set(this.state.distinctSignatures) };
  }

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  /**
   * Record a step and check if execution is stuck.
   *
   * @param step The goal step to record.
   * @returns True if execution is detected as stuck.
   */
  recordAndCheck(step: GoalStep): boolean {
    const signature = computeActionSignature(step);

    // Update recent actions window
    this.state.recentActions.push(signature);
    if (this.state.recentActions.length > this.config.stuckWindow) {
      this.state.recentActions.shift();
    }

    // Check same-action repeats
    if (signature === this.state.lastActionSignature) {
      this.state.sameActionCount++;
    } else {
      this.state.sameActionCount = 1;
      this.state.lastActionSignature = signature;
    }

    // Update distinct signatures in window
    this.state.distinctSignatures = new Set(this.state.recentActions);

    // Run stuck checks
    const isStuck = this.checkStuck();

    if (isStuck && !this.state.isStuck) {
      // Newly stuck
      this.state.isStuck = true;
      this.state.lastStuckAt = Date.now();
    } else if (!isStuck) {
      this.state.isStuck = false;
    }

    return isStuck;
  }

  /**
   * Check if the current state indicates a stuck condition.
   */
  private checkStuck(): boolean {
    // Check 1: Same action repeated too many times
    if (this.state.sameActionCount >= this.config.maxSameActionRepeats) {
      return true;
    }

    // Check 2: In the stuck window, too few distinct signatures
    if (this.state.recentActions.length >= this.config.stuckWindow) {
      if (this.state.distinctSignatures.size <= this.config.distinctMax) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the reason for stuck detection (if stuck).
   */
  getStuckReason(): string | null {
    if (!this.state.isStuck) return null;

    if (this.state.sameActionCount >= this.config.maxSameActionRepeats) {
      return `Same action repeated ${this.state.sameActionCount} times consecutively (max: ${this.config.maxSameActionRepeats})`;
    }

    if (
      this.state.recentActions.length >= this.config.stuckWindow &&
      this.state.distinctSignatures.size <= this.config.distinctMax
    ) {
      return `Only ${this.state.distinctSignatures.size} distinct action(s) in last ${this.config.stuckWindow} steps (max: ${this.config.distinctMax})`;
    }

    return 'Unknown stuck condition';
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  /**
   * Analyze a sequence of steps for stuck patterns (batch analysis).
   *
   * @param steps The steps to analyze.
   * @returns Analysis result.
   */
  analyzeSteps(steps: StepAnalysis[]): StuckAnalysisResult {
    if (steps.length === 0) {
      return { isStuck: false, patterns: [], recommendation: 'No steps to analyze' };
    }

    const patterns: string[] = [];
    let maxConsecutive = 1;
    let currentConsecutive = 1;

    // Find longest consecutive repeat
    for (let i = 1; i < steps.length; i++) {
      const sig = computeActionSignature(steps[i]);
      const prevSig = computeActionSignature(steps[i - 1]);

      if (sig === prevSig) {
        currentConsecutive++;
        maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
      } else {
        currentConsecutive = 1;
      }
    }

    if (maxConsecutive >= this.config.maxSameActionRepeats) {
      patterns.push(`Action repeated ${maxConsecutive} times consecutively`);
    }

    // Check distinct signatures in sliding windows
    const windowSize = this.config.stuckWindow;
    let minDistinct = Infinity;
    let minDistinctAt = 0;

    for (let i = 0; i <= steps.length - windowSize; i++) {
      const window = steps.slice(i, i + windowSize);
      const distinct = new Set(window.map(computeActionSignature));
      if (distinct.size < minDistinct) {
        minDistinct = distinct.size;
        minDistinctAt = i;
      }
    }

    if (minDistinct <= this.config.distinctMax) {
      patterns.push(`Only ${minDistinct} distinct action(s) in window starting at step ${minDistinctAt + 1}`);
    }

    const isStuck = patterns.length > 0;

    return {
      isStuck,
      patterns,
      recommendation: isStuck
        ? 'Consider changing strategy, breaking the task into smaller steps, or asking the user for guidance'
        : 'Execution appears to be making progress',
      maxConsecutiveRepeats: maxConsecutive,
      minDistinctInWindow: minDistinct === Infinity ? steps.length : minDistinct,
    };
  }
}

// ---------------------------------------------------------------------------
// Analysis types
// ---------------------------------------------------------------------------

export interface StepAnalysis {
  action: string;
  toolName?: string;
  result: string;
  success: boolean;
}

export interface StuckAnalysisResult {
  isStuck: boolean;
  patterns: string[];
  recommendation: string;
  maxConsecutiveRepeats: number;
  minDistinctInWindow: number;
}

// ---------------------------------------------------------------------------
// Action signature computation
// ---------------------------------------------------------------------------

/**
 * Compute a signature for an action that captures its essential character.
 * Used for detecting repeated actions.
 *
 * The signature normalizes the action by:
 * - Lowercasing
 * - Removing specific values (paths, IDs, numbers)
 * - Keeping the action structure
 */
export function computeActionSignature(step: StepAnalysis | GoalStep): string {
  const action = step.action;

  // Normalize the action
  let normalized = action.toLowerCase();

  // Remove specific values
  normalized = normalized
    .replace(/\b[0-9a-f]{8,40}\b/gi, '<ID>')     // Hex IDs
    .replace(/\b\d+\.?\d*\b/g, '<N>')                // Numbers
    .replace(/['"][^'"]*['"]/g, '<Q>')               // Quoted strings
    .replace(/(?:\/[\w.\-]+)+(?:\.[\w]+)?/g, '<PATH>') // Paths
    .replace(/\s+/g, ' ')                            // Normalize whitespace
    .trim();

  // Include tool name if present
  if (step.toolName) {
    normalized = `${step.toolName}:${normalized}`;
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a StuckDetector instance.
 */
export function createStuckDetector(config: Partial<StuckConfig> = {}): StuckDetector {
  return new StuckDetector(config);
}
