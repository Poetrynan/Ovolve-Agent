/**
 * @oa/goals — Structured GoalBrief Builder
 *
 * Builds structured GoalBrief objects from high-level descriptions.
 * The brief provides all context needed for autonomous execution:
 * objective, constraints, success criteria, and resource references.
 *
 * The builder supports both programmatic construction and LLM-assisted
 * enrichment (expanding a short description into a full brief).
 */

import type { GoalBrief } from './types';
import { DEFAULT_SCHEDULER_CONFIG } from './types';

// ---------------------------------------------------------------------------
// GoalBriefBuilder
// ---------------------------------------------------------------------------

/**
 * Builder for constructing GoalBrief objects with validation.
 */
export class GoalBriefBuilder {
  private brief: Partial<GoalBrief> = {
    constraints: [],
    successCriteria: [],
    maxSteps: DEFAULT_SCHEDULER_CONFIG.defaultMaxSteps,
    costCapUsd: DEFAULT_SCHEDULER_CONFIG.defaultCostCapUsd,
    priority: 3,
  };

  /**
   * Set the high-level objective.
   */
  setObjective(objective: string): this {
    this.brief.objective = objective;
    return this;
  }

  /**
   * Set the background context.
   */
  setContext(context: string): this {
    this.brief.context = context;
    return this;
  }

  /**
   * Add a constraint.
   */
  addConstraint(constraint: string): this {
    if (!this.brief.constraints) this.brief.constraints = [];
    this.brief.constraints.push(constraint);
    return this;
  }

  /**
   * Set all constraints (replaces existing).
   */
  setConstraints(constraints: string[]): this {
    this.brief.constraints = [...constraints];
    return this;
  }

  /**
   * Add a success criterion.
   */
  addSuccessCriterion(criterion: string): this {
    if (!this.brief.successCriteria) this.brief.successCriteria = [];
    this.brief.successCriteria.push(criterion);
    return this;
  }

  /**
   * Set all success criteria (replaces existing).
   */
  setSuccessCriteria(criteria: string[]): this {
    this.brief.successCriteria = [...criteria];
    return this;
  }

  /**
   * Set preferred approaches.
   */
  setPreferredApproaches(approaches: string[]): this {
    this.brief.preferredApproaches = [...approaches];
    return this;
  }

  /**
   * Set maximum execution steps.
   */
  setMaxSteps(maxSteps: number): this {
    this.brief.maxSteps = Math.max(1, maxSteps);
    return this;
  }

  /**
   * Set cost cap in USD.
   */
  setCostCapUsd(costCapUsd: number): this {
    this.brief.costCapUsd = Math.max(0, costCapUsd);
    return this;
  }

  /**
   * Set priority (1-5).
   */
  setPriority(priority: number): this {
    this.brief.priority = Math.max(1, Math.min(5, priority));
    return this;
  }

  /**
   * Add a resource reference.
   */
  addResource(resource: string): this {
    if (!this.brief.resources) this.brief.resources = [];
    this.brief.resources.push(resource);
    return this;
  }

  /**
   * Set resources.
   */
  setResources(resources: string[]): this {
    this.brief.resources = [...resources];
    return this;
  }

  /**
   * Set additional notes.
   */
  setNotes(notes: string): this {
    this.brief.notes = notes;
    return this;
  }

  /**
   * Build the GoalBrief.
   * @throws If required fields are missing.
   */
  build(): GoalBrief {
    if (!this.brief.objective || this.brief.objective.trim().length === 0) {
      throw new Error('GoalBrief requires an objective');
    }
    if (!this.brief.successCriteria || this.brief.successCriteria.length === 0) {
      throw new Error('GoalBrief requires at least one success criterion');
    }

    return {
      objective: this.brief.objective,
      context: this.brief.context ?? '',
      constraints: this.brief.constraints ?? [],
      successCriteria: this.brief.successCriteria,
      preferredApproaches: this.brief.preferredApproaches,
      maxSteps: this.brief.maxSteps ?? DEFAULT_SCHEDULER_CONFIG.defaultMaxSteps,
      costCapUsd: this.brief.costCapUsd ?? DEFAULT_SCHEDULER_CONFIG.defaultCostCapUsd,
      priority: this.brief.priority ?? 3,
      resources: this.brief.resources,
      notes: this.brief.notes,
    };
  }

  /**
   * Reset the builder to initial state.
   */
  reset(): this {
    this.brief = {
      constraints: [],
      successCriteria: [],
      maxSteps: DEFAULT_SCHEDULER_CONFIG.defaultMaxSteps,
      costCapUsd: DEFAULT_SCHEDULER_CONFIG.defaultCostCapUsd,
      priority: 3,
    };
    return this;
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create a new GoalBriefBuilder.
 */
export function createBriefBuilder(): GoalBriefBuilder {
  return new GoalBriefBuilder();
}

/**
 * Create a simple GoalBrief from minimal inputs.
 *
 * @param objective The high-level objective.
 * @param successCriteria Success criteria (at least one required).
 * @param options Optional additional brief fields.
 */
export function createSimpleBrief(
  objective: string,
  successCriteria: string[],
  options: Partial<Omit<GoalBrief, 'objective' | 'successCriteria'>> = {}
): GoalBrief {
  if (!objective.trim()) {
    throw new Error('GoalBrief requires an objective');
  }
  if (successCriteria.length === 0) {
    throw new Error('GoalBrief requires at least one success criterion');
  }

  return {
    objective,
    context: options.context ?? '',
    constraints: options.constraints ?? [],
    successCriteria,
    preferredApproaches: options.preferredApproaches,
    maxSteps: options.maxSteps ?? DEFAULT_SCHEDULER_CONFIG.defaultMaxSteps,
    costCapUsd: options.costCapUsd ?? DEFAULT_SCHEDULER_CONFIG.defaultCostCapUsd,
    priority: options.priority ?? 3,
    resources: options.resources,
    notes: options.notes,
  };
}

/**
 * Create a GoalBrief for a common task type.
 */
export function createTaskBrief(
  taskType: 'research' | 'implement' | 'fix' | 'refactor' | 'test' | 'document',
  description: string,
  options: Partial<Omit<GoalBrief, 'objective' | 'successCriteria'>> = {}
): GoalBrief {
  const templates: Record<typeof taskType, { objective: string; criteria: string[] }> = {
    research: {
      objective: `Research and provide comprehensive information about: ${description}`,
      criteria: [
        'All relevant aspects of the topic are covered',
        'Findings are well-organized and cited',
        'Key insights are highlighted',
      ],
    },
    implement: {
      objective: `Implement the following: ${description}`,
      criteria: [
        'Implementation is complete and functional',
        'Code follows project conventions',
        'No regressions in existing functionality',
      ],
    },
    fix: {
      objective: `Fix the following issue: ${description}`,
      criteria: [
        'The identified issue is resolved',
        'Root cause is addressed, not just symptoms',
        'No new issues introduced',
      ],
    },
    refactor: {
      objective: `Refactor the following: ${description}`,
      criteria: [
        'Code structure is improved',
        'Functionality is preserved',
        'Code quality metrics are maintained or improved',
      ],
    },
    test: {
      objective: `Create tests for: ${description}`,
      criteria: [
        'Tests cover the main functionality',
        'Edge cases are tested',
        'All tests pass',
      ],
    },
    document: {
      objective: `Document the following: ${description}`,
      criteria: [
        'Documentation is clear and comprehensive',
        'All public APIs are documented',
        'Examples are provided where appropriate',
      ],
    },
  };

  const template = templates[taskType];

  return createSimpleBrief(template.objective, template.criteria, options);
}

/**
 * Format a GoalBrief as a string for display or LLM prompt injection.
 */
export function formatBriefAsString(brief: GoalBrief): string {
  const parts: string[] = [];

  parts.push(`# Objective\n${brief.objective}\n`);

  if (brief.context) {
    parts.push(`# Context\n${brief.context}\n`);
  }

  if (brief.constraints.length > 0) {
    parts.push(`# Constraints\n${brief.constraints.map((c) => `- ${c}`).join('\n')}\n`);
  }

  if (brief.successCriteria.length > 0) {
    parts.push(`# Success Criteria\n${brief.successCriteria.map((c) => `- [ ] ${c}`).join('\n')}\n`);
  }

  if (brief.preferredApproaches && brief.preferredApproaches.length > 0) {
    parts.push(`# Preferred Approaches\n${brief.preferredApproaches.map((a) => `- ${a}`).join('\n')}\n`);
  }

  if (brief.resources && brief.resources.length > 0) {
    parts.push(`# Resources\n${brief.resources.map((r) => `- ${r}`).join('\n')}\n`);
  }

  parts.push(`# Limits\n- Max steps: ${brief.maxSteps}\n- Cost cap: $${brief.costCapUsd.toFixed(2)}\n- Priority: ${brief.priority}/5`);

  if (brief.notes) {
    parts.push(`# Notes\n${brief.notes}`);
  }

  return parts.join('\n');
}
