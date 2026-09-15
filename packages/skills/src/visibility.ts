/**
 * @oa/skills — Three-Dimensional Visibility System
 *
 * Controls how skills appear in different contexts:
 *
 * 1. include_in_runtime_registry:
 *    Whether the skill is registered in the runtime and can be matched
 *    by the trigger system. If false, the skill is dormant.
 *
 * 2. include_in_available_skills_prompt:
 *    Whether the skill's metadata appears in the Stage 1 system prompt.
 *    Skills hidden here won't be visible to the LLM as available options.
 *
 * 3. user_invocable:
 *    Whether the user can directly invoke this skill via commands.
 *    System skills may be non-invocable but still active in the registry.
 */

import type { SkillEntry, SkillVisibility } from './types';
import { DEFAULT_VISIBILITY } from './types';

// ---------------------------------------------------------------------------
// Visibility evaluation
// ---------------------------------------------------------------------------

/**
 * Resolve the effective visibility for a skill entry.
 *
 * Merges explicit visibility settings from the skill's frontmatter
 * with system defaults. Skills with no explicit visibility inherit defaults.
 *
 * @param entry The skill entry.
 */
export function resolveVisibility(entry: SkillEntry): SkillVisibility {
  return entry.visibility;
}

/**
 * Check if a skill should be included in the runtime registry.
 *
 * A skill is in the registry if it's active and has includeInRuntimeRegistry=true.
 * Being in the registry means it can be matched by triggers and executed.
 *
 * @param entry The skill entry.
 */
export function isInRuntimeRegistry(entry: SkillEntry): boolean {
  if (entry.status !== 'ACTIVE' as string && entry.status !== 'IMPORTED' as string) {
    // Only ACTIVE or IMPORTED skills are in the registry
    const status = entry.status as SkillEntry['status'];
    if (status !== 'ACTIVE' && status !== 'IMPORTED') return false;
  }
  return entry.visibility.includeInRuntimeRegistry;
}

/**
 * Check if a skill's metadata should appear in the available skills prompt.
 *
 * Controls Stage 1 visibility — whether the LLM knows this skill exists.
 *
 * @param entry The skill entry.
 */
export function isInAvailableSkillsPrompt(entry: SkillEntry): boolean {
  // Must be active to appear in prompt
  if (entry.status !== 'ACTIVE') return false;
  return entry.visibility.includeInAvailableSkillsPrompt;
}

/**
 * Check if a skill can be directly invoked by the user.
 *
 * @param entry The skill entry.
 */
export function isUserInvocable(entry: SkillEntry): boolean {
  if (entry.status !== 'ACTIVE') return false;
  return entry.visibility.userInvocable;
}

/**
 * Filter skills to those visible in the runtime registry.
 */
export function filterRuntimeRegistry(entries: SkillEntry[]): SkillEntry[] {
  return entries.filter(isInRuntimeRegistry);
}

/**
 * Filter skills to those visible in the available skills prompt.
 */
export function filterAvailableSkillsPrompt(entries: SkillEntry[]): SkillEntry[] {
  return entries.filter(isInAvailableSkillsPrompt);
}

/**
 * Filter skills to those invocable by the user.
 */
export function filterUserInvocable(entries: SkillEntry[]): SkillEntry[] {
  return entries.filter(isUserInvocable);
}

// ---------------------------------------------------------------------------
// Visibility transitions
// ---------------------------------------------------------------------------

/**
 * Create a visibility override from partial settings.
 */
export function createVisibility(
  overrides: Partial<SkillVisibility> = {}
): SkillVisibility {
  return {
    ...DEFAULT_VISIBILITY,
    ...overrides,
  };
}

/**
 * Hide a skill from the available skills prompt.
 */
export function hideFromPrompt(visibility: SkillVisibility): SkillVisibility {
  return { ...visibility, includeInAvailableSkillsPrompt: false };
}

/**
 * Show a skill in the available skills prompt.
 */
export function showInPrompt(visibility: SkillVisibility): SkillVisibility {
  return { ...visibility, includeInAvailableSkillsPrompt: true };
}

/**
 * Make a skill non-invocable by users.
 */
export function makeNonInvocable(visibility: SkillVisibility): SkillVisibility {
  return { ...visibility, userInvocable: false };
}

/**
 * Make a skill invocable by users.
 */
export function makeInvocable(visibility: SkillVisibility): SkillVisibility {
  return { ...visibility, userInvocable: true };
}

/**
 * Remove a skill from the runtime registry.
 */
export function removeFromRegistry(visibility: SkillVisibility): SkillVisibility {
  return { ...visibility, includeInRuntimeRegistry: false };
}

/**
 * Add a skill to the runtime registry.
 */
export function addToRegistry(visibility: SkillVisibility): SkillVisibility {
  return { ...visibility, includeInRuntimeRegistry: true };
}

// ---------------------------------------------------------------------------
// Visibility predicates for skill queries
// ---------------------------------------------------------------------------

/**
 * A predicate that can filter skills by visibility dimension.
 */
export type VisibilityPredicate = (entry: SkillEntry) => boolean;

/**
 * Create a predicate for a specific visibility dimension.
 */
export function createVisibilityPredicate(
  dimension: keyof SkillVisibility,
  value: boolean = true
): VisibilityPredicate {
  return (entry: SkillEntry) => entry.visibility[dimension] === value;
}

/**
 * Combine multiple visibility predicates with AND logic.
 */
export function andPredicates(...predicates: VisibilityPredicate[]): VisibilityPredicate {
  return (entry: SkillEntry) => predicates.every((p) => p(entry));
}

/**
 * Combine multiple visibility predicates with OR logic.
 */
export function orPredicates(...predicates: VisibilityPredicate[]): VisibilityPredicate {
  return (entry: SkillEntry) => predicates.some((p) => p(entry));
}
