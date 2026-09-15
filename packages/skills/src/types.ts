/**
 * @oa/skills — Core Types
 *
 * 3-stage progressive skill loading system with security scanning
 * and content-hash versioning for OvolveAgent.
 *
 * Stages:
 * - Stage 1: Metadata prompt (always available, lightweight)
 * - Stage 2: Trigger matching (loads when user intent matches)
 * - Stage 3: Full body load (on demand, with security checks)
 */

// ---------------------------------------------------------------------------
// Skill status & trust
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a loaded skill.
 */
export enum SkillStatus {
  /** Skill discovered but not yet imported. */
  DISCOVERED = 'DISCOVERED',
  /** Skill imported and validated. */
  IMPORTED = 'IMPORTED',
  /** Skill loaded and ready for use. */
  ACTIVE = 'ACTIVE',
  /** Skill temporarily disabled. */
  DISABLED = 'DISABLED',
  /** Skill failed validation or security check. */
  ERROR = 'ERROR',
}

/**
 * Trust levels controlling security scan intensity and execution permissions.
 */
export enum TrustLevel {
  /**
   * OWN — Skills authored by the system or verified developers.
   * Full permissions, minimal scanning.
   */
  OWN = 'OWN',
  /**
   * COMMUNITY — Skills from the community marketplace.
   * Standard scanning, some restrictions.
   */
  COMMUNITY = 'COMMUNITY',
  /**
   * UNTRUSTED — Skills from unknown/external sources.
   * Maximum scanning, restricted execution, user approval required.
   */
  UNTRUSTED = 'UNTRUSTED',
}

// ---------------------------------------------------------------------------
// Skill entry — the full skill record
// ---------------------------------------------------------------------------

/**
 * A skill entry representing a discovered and imported skill.
 */
export interface SkillEntry {
  /** Unique skill identifier (derived from file path or manifest). */
  id: string;
  /** Skill name (from frontmatter or filename). */
  name: string;
  /** Semantic version. */
  version: string;
  /** Short description of what the skill does. */
  description: string;
  /** Full file path to the skill definition. */
  filePath: string;
  /** Content hash (SHA-256, 16 chars) for versioning. */
  contentHash: string;
  /** Current status. */
  status: SkillStatus;
  /** Trust level assigned at import. */
  trustLevel: TrustLevel;
  /** Authors/contributors. */
  authors?: string[];
  /** Trigger patterns for Stage 2 matching. */
  triggers: SkillTrigger[];
  /** Category tags. */
  categories: string[];
  /** Skill metadata for Stage 1 prompt injection. */
  metadata: SkillMetadata;
  /** Full skill body (loaded on demand in Stage 3). */
  body?: string;
  /** Error message if status is ERROR. */
  error?: string;
  /** When the skill was discovered. */
  discoveredAt: number;
  /** When the skill was last imported. */
  importedAt?: number;
  /** When the skill body was last loaded. */
  lastLoadedAt?: number;
  /** Visibility configuration. */
  visibility: SkillVisibility;
  /** Security scan result from last import. */
  securityScan?: SecurityScanResult;
  /** Dependencies on other skills. */
  dependencies?: string[];
}

/**
 * Lightweight metadata for Stage 1 (system prompt injection).
 * This is always available without loading the full skill body.
 */
export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  version: string;
  triggers: string[];
  categories: string[];
  /** One-line usage hint. */
  usage?: string;
}

/**
 * Trigger patterns for Stage 2 matching.
 */
export interface SkillTrigger {
  /** Type of trigger. */
  type: 'keyword' | 'pattern' | 'semantic';
  /** The trigger value (keyword, regex pattern, or semantic descriptor). */
  value: string;
  /** Weight for ranking matches (higher = more relevant). */
  weight: number;
  /** Case-sensitive matching (for keyword/pattern types). */
  caseSensitive?: boolean;
}

/**
 * Three-dimensional visibility control for skills.
 */
export interface SkillVisibility {
  /** Whether to include in the runtime registry (Stage 1 prompt). */
  includeInRuntimeRegistry: boolean;
  /** Whether to include in the available skills prompt. */
  includeInAvailableSkillsPrompt: boolean;
  /** Whether the user can directly invoke this skill. */
  userInvocable: boolean;
}

// ---------------------------------------------------------------------------
// Skill configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the SkillLoader.
 */
export interface SkillConfig {
  /** Directories to scan for skills. */
  skillDirectories: string[];
  /** Default trust level for discovered skills. */
  defaultTrustLevel: TrustLevel;
  /** Whether to enable hot-reloading on file changes. */
  enableHotReload: boolean;
  /** Hot-reload check interval in milliseconds. */
  hotReloadIntervalMs: number;
  /** Maximum skill body size in bytes (default 50KB). */
  maxBodySizeBytes: number;
  /** Whether to auto-import discovered skills. */
  autoImport: boolean;
  /** Custom security rules. */
  securityRules?: SecurityRule[];
  /** Allowed file extensions for skill files. */
  allowedExtensions: string[];
  /** Whether to emit events for audit trail. */
  emitEvents: boolean;
}

/**
 * Security rule for custom scanning.
 */
export interface SecurityRule {
  name: string;
  pattern: RegExp;
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

// ---------------------------------------------------------------------------
// Security scanning
// ---------------------------------------------------------------------------

/**
 * Result of a security scan on a skill body.
 */
export interface SecurityScanResult {
  /** Whether the skill passed all critical checks. */
  passed: boolean;
  /** Individual check results. */
  checks: SecurityCheckResult[];
  /** Highest severity found. */
  highestSeverity: 'info' | 'warning' | 'critical';
  /** Scan timestamp. */
  scannedAt: number;
  /** Total scan duration in ms. */
  durationMs: number;
}

/**
 * Result of an individual security check.
 */
export interface SecurityCheckResult {
  /** Name of the check. */
  name: string;
  /** Whether this check passed. */
  passed: boolean;
  /** Severity if failed. */
  severity: 'info' | 'warning' | 'critical';
  /** Human-readable message. */
  message: string;
  /** Details (matched patterns, etc). */
  details?: string[];
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/**
 * Content hash versioning record.
 */
export interface ContentHashRecord {
  skillId: string;
  hash: string;
  previousHash?: string;
  computedAt: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type SkillEventType =
  | 'skill:discovered'
  | 'skill:imported'
  | 'skill:loaded'
  | 'skill:unloaded'
  | 'skill:reloaded'
  | 'skill:error'
  | 'skill:security_flagged';

export interface SkillEvent {
  type: SkillEventType;
  skillId: string;
  timestamp: number;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

export const DEFAULT_SKILL_CONFIG: SkillConfig = {
  skillDirectories: ['./skills', '~/.ovolveagent/skills'],
  defaultTrustLevel: TrustLevel.COMMUNITY,
  enableHotReload: true,
  hotReloadIntervalMs: 5000,
  maxBodySizeBytes: 50_000,
  autoImport: true,
  allowedExtensions: ['.md', '.txt', '.skill.md'],
  emitEvents: true,
};

/**
 * Default visibility for new skills.
 */
export const DEFAULT_VISIBILITY: SkillVisibility = {
  includeInRuntimeRegistry: true,
  includeInAvailableSkillsPrompt: true,
  userInvocable: true,
};
