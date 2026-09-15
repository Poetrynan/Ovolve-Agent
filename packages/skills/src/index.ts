/**
 * @oa/skills — Public Exports
 *
 * 3-stage progressive skill loading system with security scanning
 * and content-hash versioning.
 *
 * Stages:
 * - Stage 1: Metadata prompt (always available, lightweight)
 * - Stage 2: Trigger matching (loads when user intent matches)
 * - Stage 3: Full body load (on demand, with security checks)
 *
 * @example
 * ```ts
 * import { createSkillLoader, TrustLevel } from '@oa/skills';
 *
 * const loader = createSkillLoader({
 *   skillDirectories: ['./skills', '~/.ovolveagent/skills'],
 *   defaultTrustLevel: TrustLevel.COMMUNITY,
 * });
 *
 * await loader.initialize();
 *
 * // Stage 1: Get metadata for system prompt
 * const prompt = loader.getAvailableSkillsPromptString();
 *
 * // Stage 2: Match by triggers
 * const matches = loader.matchedByTriggers('deploy the app to production');
 *
 * // Stage 3: Load full body
 * const body = await loader.loadSkillBody('deploy-skill');
 * ```
 */

// Types
export {
  SkillStatus,
  TrustLevel,
  type SkillEntry,
  type SkillConfig,
  type SkillMetadata,
  type SkillTrigger,
  type SkillVisibility,
  type SecurityScanResult,
  type SecurityCheckResult,
  type SecurityRule,
  type ContentHashRecord,
  type SkillEvent,
  DEFAULT_SKILL_CONFIG,
  DEFAULT_VISIBILITY,
} from './types';

// Loader
export {
  SkillLoader,
  createSkillLoader,
  type SkillEventHandler,
} from './skill-loader';

// Security
export {
  runSecurityScan,
  evaluateTrustGate,
} from './security-check';

// Content hash
export {
  computeContentHash,
  computeFileHash,
  verifyContentHash,
  recordHash,
  getLatestHash,
  hasContentChanged,
  getHashHistory,
  clearHashRecords,
  getTrackedSkillIds,
} from './content-hash';

// Visibility
export {
  resolveVisibility,
  isInRuntimeRegistry,
  isInAvailableSkillsPrompt,
  isUserInvocable,
  filterRuntimeRegistry,
  filterAvailableSkillsPrompt,
  filterUserInvocable,
  createVisibility,
  hideFromPrompt,
  showInPrompt,
  makeNonInvocable,
  makeInvocable,
  removeFromRegistry,
  addToRegistry,
  createVisibilityPredicate,
  andPredicates,
  orPredicates,
  type VisibilityPredicate,
} from './visibility';
