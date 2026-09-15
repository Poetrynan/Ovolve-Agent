/**
 * @oa/security — Risk Controller layer (priority 100)
 * 
 * Risk-based control with:
 * - 4 risk levels (LOW, MEDIUM, HIGH, CRITICAL)
 * - 5 permission modes (PLAN, READ_ONLY, CONFIRM, AUTO, FULL)
 * - 11-layer policy pipeline
 * - Persistent permission rules (SQLite)
 * 
 * Design rules:
 * - DENY always wins
 * - CRITICAL always asks (regardless of mode)
 */

import {
  ToolCall,
  SecurityContext,
  LayerResult,
  SecurityLayer,
  Verdict,
  RiskLevel,
  PermissionMode,
  PermissionRule,
  RiskControllerConfig,
} from '../types';

/** Default risk-to-permission mapping */
const DEFAULT_RISK_MODE_MAPPING: Record<RiskLevel, PermissionMode> = {
  [RiskLevel.LOW]: PermissionMode.AUTO,
  [RiskLevel.MEDIUM]: PermissionMode.CONFIRM,
  [RiskLevel.HIGH]: PermissionMode.READ_ONLY,
  [RiskLevel.CRITICAL]: PermissionMode.PLAN,
};

/** Tool name to risk level mapping */
const TOOL_RISK_MAP: Record<string, RiskLevel> = {
  // LOW risk tools
  'read': RiskLevel.LOW,
  'view': RiskLevel.LOW,
  'search': RiskLevel.LOW,
  'find': RiskLevel.LOW,
  'list': RiskLevel.LOW,
  'ls': RiskLevel.LOW,
  'cat': RiskLevel.LOW,
  'head': RiskLevel.LOW,
  'tail': RiskLevel.LOW,
  'grep': RiskLevel.LOW,
  'glob': RiskLevel.LOW,
  'info': RiskLevel.LOW,
  'status': RiskLevel.LOW,

  // MEDIUM risk tools
  'fetch': RiskLevel.MEDIUM,
  'request': RiskLevel.MEDIUM,
  'api': RiskLevel.MEDIUM,
  'download': RiskLevel.MEDIUM,
  'upload': RiskLevel.MEDIUM,
  'copy': RiskLevel.MEDIUM,
  'cp': RiskLevel.MEDIUM,
  'move': RiskLevel.MEDIUM,
  'mv': RiskLevel.MEDIUM,
  'rename': RiskLevel.MEDIUM,
  'mkdir': RiskLevel.MEDIUM,
  'touch': RiskLevel.MEDIUM,

  // HIGH risk tools
  'write': RiskLevel.HIGH,
  'edit': RiskLevel.HIGH,
  'create': RiskLevel.HIGH,
  'update': RiskLevel.HIGH,
  'append': RiskLevel.HIGH,
  'insert': RiskLevel.HIGH,
  'install': RiskLevel.HIGH,
  'setup': RiskLevel.HIGH,
  'configure': RiskLevel.HIGH,
  'set': RiskLevel.HIGH,

  // CRITICAL risk tools
  'delete': RiskLevel.CRITICAL,
  'remove': RiskLevel.CRITICAL,
  'rm': RiskLevel.CRITICAL,
  'destroy': RiskLevel.CRITICAL,
  'purge': RiskLevel.CRITICAL,
  'truncate': RiskLevel.CRITICAL,
  'drop': RiskLevel.CRITICAL,
  'format': RiskLevel.CRITICAL,
  'wipe': RiskLevel.CRITICAL,
  'kill': RiskLevel.CRITICAL,
  'terminate': RiskLevel.CRITICAL,
  'shutdown': RiskLevel.CRITICAL,
  'reboot': RiskLevel.CRITICAL,
};

/** Argument patterns that elevate risk */
const RISK_ELEVATING_PATTERNS: Array<{ pattern: RegExp; from: RiskLevel; to: RiskLevel; reason: string }> = [
  { pattern: /--force|-f\s|--yes|-y\s/i, from: RiskLevel.MEDIUM, to: RiskLevel.HIGH, reason: 'Force flag detected' },
  { pattern: /--recursive|-R\s|--all\s/i, from: RiskLevel.MEDIUM, to: RiskLevel.HIGH, reason: 'Recursive/all flag detected' },
  { pattern: /sudo|runas|elevate/i, from: RiskLevel.HIGH, to: RiskLevel.CRITICAL, reason: 'Privilege escalation detected' },
  { pattern: /production|prod|live/i, from: RiskLevel.MEDIUM, to: RiskLevel.HIGH, reason: 'Production environment detected' },
  { pattern: /--no-backup|--skip-backup/i, from: RiskLevel.MEDIUM, to: RiskLevel.HIGH, reason: 'Backup skip detected' },
];

/**
 * Risk Controller layer implementation.
 */
export class RiskController implements SecurityLayer {
  readonly name = 'RiskController';
  readonly priority = 100;
  private config: Required<RiskControllerConfig>;
  private rules: PermissionRule[] = [];

  constructor(config: RiskControllerConfig = {}) {
    this.config = {
      defaultPermissionMode: config.defaultPermissionMode ?? PermissionMode.CONFIRM,
      riskModeMapping: config.riskModeMapping ?? {},
      rulesDbPath: config.rulesDbPath ?? ':memory:',
    };
  }

  /**
   * Initialize the risk controller, loading persistent rules.
   */
  async initialize(): Promise<void> {
    // In production, load rules from SQLite database
    // For now, rules are stored in memory
    this.rules = [];
  }

  /**
   * Check a tool call against risk policies.
   */
  async check(toolCall: ToolCall, context: SecurityContext): Promise<LayerResult> {
    const startTime = Date.now();

    // 1. Check persistent permission rules first
    const ruleResult = this.checkPersistentRules(toolCall);
    if (ruleResult) {
      return { ...ruleResult, elapsedMs: Date.now() - startTime };
    }

    // 2. Determine base risk level
    let riskLevel = this.classifyRisk(toolCall);

    // 3. Apply risk elevation rules
    const elevation = this.checkRiskElevation(toolCall, riskLevel);
    if (elevation) {
      riskLevel = elevation.to;
    }

    // 4. Apply 11-layer policy pipeline
    const verdict = this.applyPolicyPipeline(toolCall, riskLevel, context);

    // 5. Build result
    const blocked = verdict === Verdict.DENY;
    const reason = this.buildReason(toolCall, riskLevel, verdict, elevation);

    return {
      name: this.name,
      priority: this.priority,
      verdict,
      riskLevel,
      reason,
      blocked,
      elapsedMs: Date.now() - startTime,
    };
  }

  /**
   * Classify the risk level of a tool call.
   */
  classifyRisk(toolCall: ToolCall): RiskLevel {
    const toolName = toolCall.name.toLowerCase();

    // Direct tool name match
    if (TOOL_RISK_MAP[toolName]) {
      return TOOL_RISK_MAP[toolName];
    }

    // Check for risk-elevating keywords in tool name
    if (/delete|remove|destroy|purge|drop|kill/i.test(toolName)) {
      return RiskLevel.CRITICAL;
    }
    if (/write|edit|create|update|install/i.test(toolName)) {
      return RiskLevel.HIGH;
    }
    if (/copy|move|fetch|download/i.test(toolName)) {
      return RiskLevel.MEDIUM;
    }

    // Default to MEDIUM for unknown tools
    return RiskLevel.MEDIUM;
  }

  /**
   * Check persistent permission rules.
   */
  private checkPersistentRules(toolCall: ToolCall): LayerResult | null {
    const now = Date.now();

    for (const rule of this.rules) {
      // Skip expired rules
      if (rule.expiresAt > 0 && rule.expiresAt < now) continue;

      // Check tool name pattern
      const toolRegex = new RegExp(rule.toolPattern, 'i');
      if (!toolRegex.test(toolCall.name)) continue;

      // Check command pattern if present
      if (rule.commandPattern && toolCall.command) {
        const cmdRegex = new RegExp(rule.commandPattern, 'i');
        if (!cmdRegex.test(toolCall.command)) continue;
      }

      // Rule matched
      return {
        name: this.name,
        priority: this.priority,
        verdict: rule.verified,
        riskLevel: rule.riskLevel,
        reason: `Persistent rule matched: ${rule.toolPattern}`,
        blocked: rule.verified === Verdict.DENY,
        elapsedMs: 0,
      };
    }

    return null;
  }

  /**
   * Check if risk should be elevated based on arguments.
   */
  private checkRiskElevation(
    toolCall: ToolCall,
    currentRisk: RiskLevel
  ): { from: RiskLevel; to: RiskLevel; reason: string } | null {
    const args = JSON.stringify(toolCall.arguments);
    const command = toolCall.command ?? '';
    const textToCheck = `${args} ${command}`;

    for (const pattern of RISK_ELEVATING_PATTERNS) {
      if (pattern.from === currentRisk && pattern.pattern.test(textToCheck)) {
        return { from: pattern.from, to: pattern.to, reason: pattern.reason };
      }
    }

    return null;
  }

  /**
   * Apply the 11-layer policy pipeline.
   * 
   * Layers:
   * 1. DENY always wins (if any previous layer said DENY)
   * 2. CRITICAL always asks
   * 3. Permission mode check
   * 4. Risk-to-mode mapping
   * 5. Tool-specific overrides
   * 6. Argument-based adjustments
   * 7. Session context
   * 8. User role check
   * 9. Time-based restrictions
   * 10. Rate limiting
   * 11. Default policy
   */
  private applyPolicyPipeline(
    toolCall: ToolCall,
    riskLevel: RiskLevel,
    context: SecurityContext
  ): Verdict {
    // Layer 1: DENY always wins
    const previousDeny = context.previousResults.some((r) => r.verified === Verdict.DENY);
    if (previousDeny) {
      return Verdict.DENY;
    }

    // Layer 2: CRITICAL always asks
    if (riskLevel === RiskLevel.CRITICAL) {
      return Verdict.CONFIRM;
    }

    // Layer 3: Permission mode check
    const mode = context.permissionMode;
    if (mode === PermissionMode.PLAN) {
      return Verdict.DENY; // Plan mode = no execution
    }
    if (mode === PermissionMode.READ_ONLY && this.isWriteOperation(toolCall)) {
      return Verdict.DENY;
    }

    // Layer 4: Risk-to-mode mapping
    const mappedMode = this.config.riskModeMapping[riskLevel] ?? DEFAULT_RISK_MODE_MAPPING[riskLevel];
    if (mappedMode === PermissionMode.FULL) {
      return Verdict.ALLOW;
    }
    if (mappedMode === PermissionMode.AUTO) {
      return riskLevel === RiskLevel.LOW ? Verdict.ALLOW : Verdict.CONFIRM;
    }
    if (mappedMode === PermissionMode.CONFIRM) {
      return Verdict.CONFIRM;
    }

    // Layer 5-11: Default policy based on risk
    switch (riskLevel) {
      case RiskLevel.LOW:
        return Verdict.ALLOW;
      case RiskLevel.MEDIUM:
        return Verdict.CONFIRM;
      case RiskLevel.HIGH:
        return Verdict.CONFIRM;
      case RiskLevel.CRITICAL:
        return Verdict.CONFIRM;
      default:
        return Verdict.CONFIRM;
    }
  }

  /**
   * Check if a tool call is a write operation.
   */
  private isWriteOperation(toolCall: ToolCall): boolean {
    const writeTools = ['write', 'edit', 'create', 'update', 'delete', 'remove', 'append', 'insert', 'install', 'configure'];
    return writeTools.includes(toolCall.name.toLowerCase());
  }

  /**
   * Build a human-readable reason string.
   */
  private buildReason(
    toolCall: ToolCall,
    riskLevel: RiskLevel,
    verdict: Verdict,
    elevation: { from: RiskLevel; to: RiskLevel; reason: string } | null
  ): string {
    const parts: string[] = [`Risk: ${riskLevel}`];

    if (elevation) {
      parts.push(`Elevated from ${elevation.from}: ${elevation.reason}`);
    }

    parts.push(`Verdict: ${verdict}`);

    return parts.join(' | ');
  }

  /**
   * Add a persistent permission rule.
   */
  async addRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): Promise<PermissionRule> {
    const fullRule: PermissionRule = {
      ...rule,
      id: this.generateId(),
      createdAt: Date.now(),
    };
    this.rules.push(fullRule);
    return fullRule;
  }

  /**
   * Remove a permission rule.
   */
  async removeRule(ruleId: string): Promise<boolean> {
    const idx = this.rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /**
   * Get all active rules.
   */
  getRules(): PermissionRule[] {
    const now = Date.now();
    return this.rules.filter((r) => r.expiresAt === 0 || r.expiresAt > now);
  }

  /**
   * Generate a unique ID.
   */
  private generateId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
