/**
 * @oa/skills — SkillLoader
 *
 * Main skill loading system implementing 3-stage progressive disclosure:
 *
 * - Stage 1 (Metadata): Lightweight skill metadata injected into system prompt.
 *   Always available, no body loading required.
 *
 * - Stage 2 (Trigger Matching): When user intent matches a skill's triggers,
 *   the skill is identified for potential loading.
 *
 * - Stage 3 (Full Body Load): The complete skill body is loaded on demand,
 *   with full security scanning and trust verification.
 *
 * Features:
 * - Content-hash versioning for change detection
 * - Hot-reloading when skill files change
 * - 4-layer security scanning with trust gates
 * - Three-dimensional visibility control
 * - Event emission for audit trail
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import type {
  SkillConfig,
  SkillEntry,
  SkillEvent,
  SkillMetadata,
  SkillStatus,
  SkillTrigger,
  SkillVisibility,
  TrustLevel,
  SecurityScanResult,
} from './types';
import { DEFAULT_SKILL_CONFIG, SkillStatus as Status, TrustLevel as Trust } from './types';
import { computeContentHash, computeFileHash, hasContentChanged, recordHash, verifyContentHash } from './content-hash';
import { runSecurityScan, evaluateTrustGate } from './security-check';
import {
  createVisibility,
  isInAvailableSkillsPrompt,
  isInRuntimeRegistry,
  isUserInvocable,
} from './visibility';

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type SkillEventHandler = (event: SkillEvent) => void;

// ---------------------------------------------------------------------------
// SkillLoader
// ---------------------------------------------------------------------------

export class SkillLoader {
  private readonly config: SkillConfig;
  private readonly skills: Map<string, SkillEntry> = new Map();
  private readonly eventHandlers: Set<SkillEventHandler> = new Set();
  private hotReloadTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<SkillConfig> = {}) {
    this.config = { ...DEFAULT_SKILL_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the skill loader — discover and optionally auto-import skills.
   */
  async initialize(): Promise<void> {
    await this.discover(this.config.skillDirectories);

    if (this.config.enableHotReload) {
      this.startHotReload();
    }
  }

  /**
   * Shutdown the skill loader and release resources.
   */
  shutdown(): void {
    this.stopHotReload();
    this.skills.clear();
    this.eventHandlers.clear();
  }

  // -------------------------------------------------------------------------
  // Event system
  // -------------------------------------------------------------------------

  /**
   * Subscribe to skill events.
   */
  onEvent(handler: SkillEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: SkillEvent): void {
    if (!this.config.emitEvents) return;
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Handlers must not break the loader
      }
    }
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Scan skill directories and discover skill files.
   *
   * @param paths Directories to scan.
   * @returns Array of discovered skill entries (not yet imported).
   */
  async discover(paths: string[]): Promise<SkillEntry[]> {
    const discovered: SkillEntry[] = [];

    for (const dirPath of paths) {
      const resolved = resolve(dirPath);
      if (!existsSync(resolved)) continue;

      try {
        const entries = readdirSync(resolved, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            // Recursively scan subdirectories
            discovered.push(...await this.discover([join(resolved, entry.name)]));
          } else if (this.isSkillFile(entry.name)) {
            const filePath = join(resolved, entry.name);
            const skillEntry = await this.createDiscoveredEntry(filePath);

            if (skillEntry) {
              this.skills.set(skillEntry.id, skillEntry);
              discovered.push(skillEntry);

              this.emit({
                type: 'skill:discovered',
                skillId: skillEntry.id,
                timestamp: Date.now(),
                data: { filePath, name: skillEntry.name },
              });

              // Auto-import if configured
              if (this.config.autoImport) {
                await this.importSkill(skillEntry.filePath, this.config.defaultTrustLevel);
              }
            }
          }
        }
      } catch {
        // Directory read failed — skip
      }
    }

    return discovered;
  }

  /**
   * Check if a filename matches skill file patterns.
   */
  private isSkillFile(fileName: string): boolean {
    const ext = extname(fileName).toLowerCase();
    if (this.config.allowedExtensions.includes(ext)) return true;

    // Check compound extensions like .skill.md
    for (const allowed of this.config.allowedExtensions) {
      if (allowed.startsWith('.') && fileName.endsWith(allowed)) return true;
    }

    return false;
  }

  /**
   * Create a skill entry from a discovered file (without importing).
   */
  private async createDiscoveredEntry(filePath: string): Promise<SkillEntry | null> {
    try {
      const stat = statSync(filePath);
      if (stat.size > this.config.maxBodySizeBytes) {
        return null; // File too large
      }

      const content = readFileSync(filePath, 'utf-8');
      const hash = computeContentHash(content);
      const parsed = parseSkillContent(content, filePath);

      return {
        id: parsed.id,
        name: parsed.name,
        version: parsed.version,
        description: parsed.description,
        filePath,
        contentHash: hash,
        status: Status.DISCOVERED,
        trustLevel: this.config.defaultTrustLevel,
        triggers: parsed.triggers,
        categories: parsed.categories,
        metadata: parsed.metadata,
        visibility: parsed.visibility,
        discoveredAt: Date.now(),
        dependencies: parsed.dependencies,
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  /**
   * Import a skill from a file path with security checks.
   *
   * @param filePath Path to the skill file.
   * @param trustLevel Trust level to assign.
   * @returns The imported skill entry, or null if import failed.
   */
  async importSkill(filePath: string, trustLevel: TrustLevel = Trust.COMMUNITY): Promise<SkillEntry | null> {
    try {
      const content = readFileSync(filePath, 'utf-8');

      // Size check
      if (Buffer.byteLength(content, 'utf-8') > this.config.maxBodySizeBytes) {
        return null;
      }

      // Compute hash
      const hash = computeContentHash(content);

      // Parse skill content
      const parsed = parseSkillContent(content, filePath);

      // Run security scan
      const securityResult = runSecurityScan(content, trustLevel, this.config.securityRules);

      // Evaluate trust gate
      const gateResult = evaluateTrustGate(securityResult, trustLevel);

      // If blocked and doesn't require approval, reject
      if (!gateResult.allowed && !gateResult.requiresApproval) {
        const entry: SkillEntry = {
          id: parsed.id,
          name: parsed.name,
          version: parsed.version,
          description: parsed.description,
          filePath,
          contentHash: hash,
          status: Status.ERROR,
          trustLevel,
          triggers: parsed.triggers,
          categories: parsed.categories,
          metadata: parsed.metadata,
          visibility: parsed.visibility,
          discoveredAt: Date.now(),
          error: gateResult.reason,
          securityScan: securityResult,
          dependencies: parsed.dependencies,
        };
        this.skills.set(parsed.id, entry);

        this.emit({
          type: 'skill:security_flagged',
          skillId: parsed.id,
          timestamp: Date.now(),
          data: { reason: gateResult.reason, scan: securityResult },
        });

        return null;
      }

      // Record hash
      recordHash(parsed.id, hash);

      // Create entry
      const entry: SkillEntry = {
        id: parsed.id,
        name: parsed.name,
        version: parsed.version,
        description: parsed.description,
        filePath,
        contentHash: hash,
        status: Status.IMPORTED,
        trustLevel,
        triggers: parsed.triggers,
        categories: parsed.categories,
        metadata: parsed.metadata,
        visibility: parsed.visibility,
        discoveredAt: Date.now(),
        importedAt: Date.now(),
        securityScan: securityResult,
        dependencies: parsed.dependencies,
      };

      this.skills.set(parsed.id, entry);

      this.emit({
        type: 'skill:imported',
        skillId: parsed.id,
        timestamp: Date.now(),
        data: { name: parsed.name, trustLevel, securityPassed: securityResult.passed },
      });

      return entry;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Body loading
  // -------------------------------------------------------------------------

  /**
   * Load the full body of a skill on demand (Stage 3).
   *
   * @param name The skill name or ID.
   * @returns The skill body content, or null if not available.
   */
  async loadSkillBody(name: string): Promise<string | null> {
    const entry = this.findSkill(name);
    if (!entry) return null;

    // If body already loaded, return it
    if (entry.body) {
      return entry.body;
    }

    try {
      const content = readFileSync(entry.filePath, 'utf-8');

      // Verify hash hasn't changed since import
      if (!verifyContentHash(content, entry.contentHash)) {
        // Content changed — re-import
        await this.importSkill(entry.filePath, entry.trustLevel);
        const updated = this.findSkill(name);
        if (!updated) return null;
      }

      // Load body
      entry.body = content;
      entry.status = Status.ACTIVE;
      entry.lastLoadedAt = Date.now();

      this.emit({
        type: 'skill:loaded',
        skillId: entry.id,
        timestamp: Date.now(),
        data: { name: entry.name },
      });

      return content;
    } catch {
      entry.status = Status.ERROR;
      entry.error = 'Failed to read skill file';

      this.emit({
        type: 'skill:error',
        skillId: entry.id,
        timestamp: Date.now(),
        data: { error: 'Failed to read skill file' },
      });

      return null;
    }
  }

  /**
   * Unload a skill's body to free memory.
   *
   * @param name The skill name or ID.
   */
  unloadSkill(name: string): boolean {
    const entry = this.findSkill(name);
    if (!entry) return false;

    entry.body = undefined;
    entry.status = Status.IMPORTED;
    entry.lastLoadedAt = undefined;

    this.emit({
      type: 'skill:unloaded',
      skillId: entry.id,
      timestamp: Date.now(),
      data: { name: entry.name },
    });

    return true;
  }

  // -------------------------------------------------------------------------
  // Listing & queries
  // -------------------------------------------------------------------------

  /**
   * List all skills, optionally filtered by status.
   *
   * @param status Optional status filter.
   */
  listSkills(status?: SkillStatus): SkillEntry[] {
    const all = Array.from(this.skills.values());
    if (status) {
      return all.filter((s) => s.status === status);
    }
    return all;
  }

  /**
   * Get a skill by name or ID.
   */
  getSkill(name: string): SkillEntry | null {
    return this.findSkill(name);
  }

  /**
   * Find a skill by name or ID (internal).
   */
  private findSkill(name: string): SkillEntry | null {
    // Try ID first
    let entry = this.skills.get(name);
    if (entry) return entry;

    // Try name
    for (const skill of this.skills.values()) {
      if (skill.name === name) return skill;
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Stage 1: Metadata prompt
  // -------------------------------------------------------------------------

  /**
   * Get Stage 1 metadata for the system prompt.
   *
   * Returns lightweight metadata for all skills that should appear
   * in the available skills prompt. This is injected into the system
   * prompt so the LLM knows what skills are available.
   */
  getAvailableSkillsPrompt(): SkillMetadata[] {
    return Array.from(this.skills.values())
      .filter(isInAvailableSkillsPrompt)
      .map((entry) => entry.metadata);
  }

  /**
   * Get the Stage 1 prompt section as a formatted string.
   */
  getAvailableSkillsPromptString(): string {
    const skills = this.getAvailableSkillsPrompt();
    if (skills.length === 0) return '';

    const lines = skills.map((s) => {
      const triggers = s.triggers.length > 0 ? ` (triggers: ${s.triggers.join(', ')})` : '';
      return `- **${s.name}**${triggers}: ${s.description}`;
    });

    return `## Available Skills\n\n${lines.join('\n')}\n\nTo use a skill, invoke it by name or describe your need and the system will match the best skill.`;
  }

  // -------------------------------------------------------------------------
  // Stage 2: Trigger matching
  // -------------------------------------------------------------------------

  /**
   * Match skills by trigger patterns against a user message.
   *
   * Returns skills ranked by trigger match score. Only returns skills
   * that are in the runtime registry.
   *
   * @param message The user message to match against.
   * @param limit Maximum number of results (default 5).
   */
  matchedByTriggers(message: string, limit: number = 5): Array<{ entry: SkillEntry; score: number; matchedTriggers: string[] }> {
    const results: Array<{ entry: SkillEntry; score: number; matchedTriggers: string[] }> = [];

    for (const entry of this.skills.values()) {
      if (!isInRuntimeRegistry(entry)) continue;

      let score = 0;
      const matchedTriggers: string[] = [];

      for (const trigger of entry.triggers) {
        const matchScore = matchTrigger(message, trigger);
        if (matchScore > 0) {
          score += matchScore;
          matchedTriggers.push(trigger.value);
        }
      }

      if (score > 0) {
        results.push({ entry, score, matchedTriggers });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Hot reload
  // -------------------------------------------------------------------------

  /**
   * Check if a skill's file has changed and re-import if needed.
   *
   * @param name The skill name or ID.
   * @returns True if the skill was re-imported.
   */
  async reimportIfChanged(name: string): Promise<boolean> {
    const entry = this.findSkill(name);
    if (!entry) return false;

    const currentHash = computeFileHash(entry.filePath);
    if (!currentHash || currentHash === entry.contentHash) return false;

    // Content changed — re-import
    const newEntry = await this.importSkill(entry.filePath, entry.trustLevel);
    if (newEntry) {
      this.emit({
        type: 'skill:reloaded',
        skillId: newEntry.id,
        timestamp: Date.now(),
        data: { name: newEntry.name, oldHash: entry.contentHash, newHash: currentHash },
      });
      return true;
    }

    return false;
  }

  /**
   * Start hot-reload polling.
   */
  private startHotReload(): void {
    if (this.hotReloadTimer) return;

    this.hotReloadTimer = setInterval(async () => {
      for (const entry of this.skills.values()) {
        try {
          await this.reimportIfChanged(entry.id);
        } catch {
          // Ignore errors during hot-reload
        }
      }
    }, this.config.hotReloadIntervalMs);
  }

  /**
   * Stop hot-reload polling.
   */
  private stopHotReload(): void {
    if (this.hotReloadTimer) {
      clearInterval(this.hotReloadTimer);
      this.hotReloadTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /**
   * Get loader statistics.
   */
  getStats(): {
    total: number;
    byStatus: Record<SkillStatus, number>;
    byTrust: Record<TrustLevel, number>;
    runtimeRegistry: number;
    userInvocable: number;
  } {
    const all = Array.from(this.skills.values());
    const byStatus: Record<SkillStatus, number> = {
      [Status.DISCOVERED]: 0,
      [Status.IMPORTED]: 0,
      [Status.ACTIVE]: 0,
      [Status.DISABLED]: 0,
      [Status.ERROR]: 0,
    };
    const byTrust: Record<TrustLevel, number> = {
      [Trust.OWN]: 0,
      [Trust.COMMUNITY]: 0,
      [Trust.UNTRUSTED]: 0,
    };

    for (const skill of all) {
      byStatus[skill.status]++;
      byTrust[skill.trustLevel]++;
    }

    return {
      total: all.length,
      byStatus,
      byTrust,
      runtimeRegistry: all.filter(isInRuntimeRegistry).length,
      userInvocable: all.filter(isUserInvocable).length,
    };
  }
}

// ---------------------------------------------------------------------------
// Skill content parser
// ---------------------------------------------------------------------------

interface ParsedSkill {
  id: string;
  name: string;
  version: string;
  description: string;
  triggers: SkillTrigger[];
  categories: string[];
  metadata: SkillMetadata;
  visibility: SkillVisibility;
  dependencies?: string[];
}

/**
 * Parse skill content from a markdown file.
 *
 * Expected format:
 * ```markdown
 * ---
 * name: my-skill
 * version: 1.0.0
 * description: What this skill does
 * triggers:
 *   - keyword:deploy
 *   - pattern:deploy.*to.*
 * categories:
 *   - devops
 * visibility:
 *   include_in_runtime_registry: true
 *   include_in_available_skills_prompt: true
 *   user_invocable: true
 * dependencies:
 *   - other-skill
 * ---
 *
 * # Skill Body
 * The actual skill instructions...
 * ```
 */
function parseSkillContent(content: string, filePath: string): ParsedSkill {
  // Extract frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';

  // Parse simple YAML-like frontmatter
  const name = extractYamlString(frontmatter, 'name') || basename(filePath, extname(filePath));
  const version = extractYamlString(frontmatter, 'version') || '0.1.0';
  const description = extractYamlString(frontmatter, 'description') || '';
  const triggers = extractTriggers(frontmatter);
  const categories = extractYamlArray(frontmatter, 'categories');
  const dependencies = extractYamlArray(frontmatter, 'dependencies');

  // Parse visibility
  const visibility: SkillVisibility = createVisibility({
    includeInRuntimeRegistry: extractYamlBool(frontmatter, 'include_in_runtime_registry', true),
    includeInAvailableSkillsPrompt: extractYamlBool(frontmatter, 'include_in_available_skills_prompt', true),
    userInvocable: extractYamlBool(frontmatter, 'user_invocable', true),
  });

  const id = computeContentHash(filePath).slice(0, 12) + '_' + name.replace(/[^a-zA-Z0-9_-]/g, '_');

  const metadata: SkillMetadata = {
    id,
    name,
    description,
    version,
    triggers: triggers.map((t) => t.value),
    categories,
  };

  return { id, name, version, description, triggers, categories, metadata, visibility, dependencies };
}

// ---------------------------------------------------------------------------
// YAML-like frontmatter helpers
// ---------------------------------------------------------------------------

function extractYamlString(yaml: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(yaml);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

function extractYamlBool(yaml: string, key: string, defaultValue: boolean): boolean {
  const value = extractYamlString(yaml, key);
  if (value === null) return defaultValue;
  return value.toLowerCase() === 'true';
}

function extractYamlArray(yaml: string, key: string): string[] {
  const match = new RegExp(`^${key}:\\s*$([\\s\\S]*?)(?=\\n[a-z]|$)`, 'm').exec(yaml);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.trim().replace(/^-\s*/, ''))
    .filter((line) => line.length > 0);
}

function extractTriggers(yaml: string): SkillTrigger[] {
  const triggers: SkillTrigger[] = [];
  const triggerSection = yaml.match(/^triggers:\s*$([\s\S]*?)(?=\n[a-z]|$)/m);

  if (triggerSection) {
    const lines = triggerSection[1].split('\n').map((l) => l.trim()).filter((l) => l);

    for (const line of lines) {
      // Format: "- keyword:value" or "- pattern:value" or "- value"
      const keywordMatch = line.match(/^-\s*keyword:\s*(.+)$/i);
      const patternMatch = line.match(/^-\s*pattern:\s*(.+)$/i);
      const simpleMatch = line.match(/^-\s*(.+)$/);

      if (keywordMatch) {
        triggers.push({ type: 'keyword', value: keywordMatch[1], weight: 1 });
      } else if (patternMatch) {
        triggers.push({ type: 'pattern', value: patternMatch[1], weight: 1.5 });
      } else if (simpleMatch) {
        triggers.push({ type: 'keyword', value: simpleMatch[1], weight: 1 });
      }
    }
  }

  return triggers;
}

// ---------------------------------------------------------------------------
// Trigger matching
// ---------------------------------------------------------------------------

/**
 * Match a single trigger against a message.
 * Returns a match score (0 = no match).
 */
function matchTrigger(message: string, trigger: SkillTrigger): number {
  switch (trigger.type) {
    case 'keyword': {
      const msg = trigger.caseSensitive ? message : message.toLowerCase();
      const val = trigger.caseSensitive ? trigger.value : trigger.value.toLowerCase();
      return msg.includes(val) ? trigger.weight : 0;
    }

    case 'pattern': {
      try {
        const flags = trigger.caseSensitive ? '' : 'i';
        const regex = new RegExp(trigger.value, flags);
        return regex.test(message) ? trigger.weight : 0;
      } catch {
        return 0; // Invalid regex
      }
    }

    case 'semantic':
      // Semantic matching requires embeddings — not implemented here
      // Return 0 to indicate no match via this method
      return 0;

    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SkillLoader instance.
 */
export function createSkillLoader(config: Partial<SkillConfig> = {}): SkillLoader {
  return new SkillLoader(config);
}
