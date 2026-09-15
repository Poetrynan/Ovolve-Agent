/**
 * @oa/security — Main SecurityPipeline class
 * 
 * Orchestrates the full 7-layer defense-in-depth security system:
 * 1. Sanitizer (priority 50) — Output sanitization
 * 2. Risk Controller (priority 100) — Risk-based control
 * 3. Tool Hooks (priority 150) — Pre/post/abort hooks
 * 4. Output Guard (priority 200) — Anti-leakage
 * 5. Danger Classifier (priority 250) — Cross-interpreter classification
 * 6. Path Guard (priority 300) — Path validation
 * 
 * Design principles:
 * - Defense in depth: multiple layers check each request
 * - Fail-safe defaults: when in doubt, deny
 * - DENY always wins: any layer can block
 * - CRITICAL always asks: highest risk requires confirmation
 */

import {
  ToolCall,
  SecurityContext,
  SecurityLayer,
  LayerResult,
  PipelineResult,
  SecurityResult,
  SecurityPipelineConfig,
  Verdict,
  RiskLevel,
  PermissionMode,
  PermissionRule,
} from './types';
import { Sanitizer } from './layers/sanitizer';
import { RiskController } from './layers/risk-controller';
import { ToolHooks } from './layers/tool-hooks';
import { OutputGuard } from './layers/output-guard';
import { DangerClassifier } from './layers/danger-classifier';
import { PathGuard } from './layers/path-guard';

/**
 * SecurityPipeline — the main security system facade.
 */
export class SecurityPipeline {
  private layers: SecurityLayer[] = [];
  private config: Required<SecurityPipelineConfig>;
  private initialized = false;

  constructor(config: SecurityPipelineConfig = {}) {
    this.config = {
      permissionMode: config.permissionMode ?? PermissionMode.CONFIRM,
      workspaceRoot: config.workspaceRoot ?? '',
      userHome: userHome ?? '',
      isRoot: config.isRoot ?? false,
      pathGuard: config.pathGuard ?? {},
      dangerClassifier: config.dangerClassifier ?? {},
      riskController: config.riskController ?? {},
      outputGuard: config.outputGuard ?? {},
      sanitizer: config.sanitizer ?? {},
      toolHooks: config.toolHooks ?? {},
    };
  }

  /**
   * Initialize the security pipeline and all layers.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create layers in priority order
    this.layers = [
      new Sanitizer(this.config.sanitizer),
      new RiskController(this.config.riskController),
      new ToolHooks(this.config.toolHooks),
      new OutputGuard(this.config.outputGuard),
      new DangerClassifier(this.config.dangerClassifier),
      new PathGuard(this.config.pathGuard),
    ];

    // Sort by priority (lower = runs first)
    this.layers.sort((a, b) => a.priority - b.priority);

    // Initialize layers that need it
    for (const layer of this.layers) {
      if ('initialize' in layer && typeof layer.initialize === 'function') {
        await (layer as any).initialize();
      }
    }

    this.initialized = true;
  }

  /**
   * Run the full security pipeline on a tool call.
   */
  async process(sessionId: string, toolCalls: ToolCall[]): Promise<PipelineResult[]> {
    const results: PipelineResult[] = [];

    for (const toolCall of toolCalls) {
      const result = await this.processSingle(sessionId, toolCall);
      results.push(result);
    }

    return results;
  }

  /**
   * Process a single tool call through the pipeline.
   */
  async processSingle(sessionId: string, toolCall: ToolCall): Promise<PipelineResult> {
    const startTime = Date.now();

    // Build security context
    const context = this.buildContext(sessionId);

    // Run each layer in priority order
    const layerResults: LayerResult[] = [];
    let finalVerdict = Verdict.ALLOW;
    let finalRiskLevel = RiskLevel.LOW;
    let blocked = false;
    let sanitizedArguments = toolCall.arguments;

    for (const layer of this.layers) {
      // Update context with previous results
      context.previousResults = layerResults;

      try {
        const result = await layer.check(toolCall, context);
        layerResults.push(result);

        // DENY always wins
        if (result.verified === Verdict.DENY) {
          finalVerdict = Verdict.DENY;
          finalRiskLevel = result.riskLevel;
          blocked = true;
          break; // Stop processing — denied
        }

        // Track highest risk level
        if (this.riskLevelValue(result.riskLevel) > this.riskLevelValue(finalRiskLevel)) {
          finalRiskLevel = result.riskLevel;
        }

        // Track most restrictive verdict
        if (result.verified === Verdict.CONFIRM && finalVerdict !== Verdict.DENY) {
          finalVerdict = Verdict.CONFIRM;
        }

        // Capture sanitized arguments from sanitizer
        if (layer.name === 'Sanitizer' && result.blocked === false) {
          // Sanitizer doesn't block, but may modify
        }
      } catch (error) {
        // Fail-safe: on error, deny
        layerResults.push({
          name: layer.name,
          priority: layer.priority,
          verdict: Verdict.DENY,
          riskLevel: RiskLevel.CRITICAL,
          reason: `Layer error: ${error instanceof Error ? error.message : String(error)}`,
          blocked: true,
          elapsedMs: 0,
        });
        finalVerdict = Verdict.DENY;
        finalRiskLevel = RiskLevel.CRITICAL;
        blocked = true;
        break;
      }
    }

    // CRITICAL always asks (even if no layer said CONFIRM)
    if (finalRiskLevel === RiskLevel.CRITICAL && finalVerdict !== Verdict.DENY) {
      finalVerdict = Verdict.CONFIRM;
    }

    // Build final message
    const message = this.buildMessage(finalVerdict, finalRiskLevel, layerResults);

    return {
      allowed: finalVerdict === Verdict.ALLOW,
      verdict: finalVerdict,
      riskLevel: finalRiskLevel,
      layerResults,
      sanitizedArguments,
      message,
      elapsedMs: Date.now() - startTime,
    };
  }

  /**
   * Classify the risk level of a tool call (without full pipeline).
   */
  classify(toolCall: ToolCall): SecurityResult {
    // Quick classification based on tool name and arguments
    const riskLevel = this.quickClassify(toolCall);

    return {
      verdict: riskLevel === RiskLevel.CRITICAL ? Verdict.CONFIRM : Verdict.ALLOW,
      riskLevel,
      reason: `Quick classification: ${riskLevel}`,
      source: 'SecurityPipeline.classify',
      final: false,
    };
  }

  /**
   * Run all security checks on a tool call.
   */
  async check(toolCall: ToolCall): Promise<SecurityResult> {
    const result = await this.processSingle(toolCall.sessionId, toolCall);

    return {
      verdict: result.verified,
      riskLevel: result.riskLevel,
      reason: result.message,
      source: 'SecurityPipeline.check',
      final: true,
      metadata: {
        layerResults: result.layerResults,
        elapsedMs: result.elapsedMs,
      },
    };
  }

  /**
   * Post-process tool output (secret redaction).
   */
  postProcess(toolCall: ToolCall, output: string): string {
    const toolHook = this.layers.find((l) => l.name === 'ToolHooks') as ToolHooks | undefined;
    if (toolHook) {
      return toolHook.postProcess(toolCall, output);
    }
    return output;
  }

  /**
   * Sanitize output text.
   */
  sanitizeOutput(text: string): string {
    const sanitizer = this.layers.find((l) => l.name === 'Sanitizer') as Sanitizer | undefined;
    if (sanitizer) {
      return sanitizer.sanitizeText(text);
    }
    return text;
  }

  /**
   * Add a persistent permission rule.
   */
  async addPermissionRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): Promise<PermissionRule> {
    const riskController = this.layers.find((l) => l.name === 'RiskController') as RiskController | undefined;
    if (riskController) {
      return riskController.addRule(rule);
    }
    throw new Error('RiskController layer not found');
  }

  /**
   * Remove a permission rule.
   */
  async removePermissionRule(ruleId: string): Promise<boolean> {
    const riskController = this.layers.find((l) => l.name === 'RiskController') as RiskController | undefined;
    if (riskController) {
      return riskController.removeRule(ruleId);
    }
    return false;
  }

  /**
   * Get all active permission rules.
   */
  getPermissionRules(): PermissionRule[] {
    const riskController = this.layers.find((l) => l.name === 'RiskController') as RiskController | undefined;
    if (riskController) {
      return riskController.getRules();
    }
    return [];
  }

  /**
   * Get the current permission mode.
   */
  getPermissionMode(): PermissionMode {
    return this.config.permissionMode;
  }

  /**
   * Set the permission mode.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.config.permissionMode = mode;
  }

  /**
   * Get all registered layers.
   */
  getLayers(): SecurityLayer[] {
    return [...this.layers];
  }

  /**
   * Build the security context for a session.
   */
  private buildContext(sessionId: string): SecurityContext {
    return {
      permissionMode: this.config.permissionMode,
      workspaceRoot: this.config.workspaceRoot,
      userHome: this.config.userHome,
      isRoot: this.config.isRoot,
      sessionId,
      previousResults: [],
      permissionRules: this.getPermissionRules(),
    };
  }

  /**
   * Quick classify a tool call without running full pipeline.
   */
  private quickClassify(toolCall: ToolCall): RiskLevel {
    const name = toolCall.name.toLowerCase();

    // Critical risk tools
    if (/delete|remove|destroy|purge|drop|kill|shutdown|reboot|format|wipe/.test(name)) {
      return RiskLevel.CRITICAL;
    }

    // High risk tools
    if (/write|edit|create|update|install|configure/.test(name)) {
      return RiskLevel.HIGH;
    }

    // Medium risk tools
    if (/copy|move|fetch|download|upload|rename/.test(name)) {
      return RiskLevel.MEDIUM;
    }

    // Low risk tools (default for read-only)
    if (/read|view|search|find|list|info|status/.test(name)) {
      return RiskLevel.LOW;
    }

    // Unknown tools default to medium
    return RiskLevel.MEDIUM;
  }

  /**
   * Convert risk level to numeric value for comparison.
   */
  private riskLevelValue(riskLevel: RiskLevel): number {
    switch (riskLevel) {
      case RiskLevel.LOW: return 0;
      case RiskLevel.MEDIUM: return 1;
      case RiskLevel.HIGH: return 2;
      case RiskLevel.CRITICAL: return 3;
      default: return 1;
    }
  }

  /**
   * Build a human-readable message from the pipeline result.
   */
  private buildMessage(verdict: Verdict, riskLevel: RiskLevel, layerResults: LayerResult[]): string {
    const parts: string[] = [];

    switch (verdict) {
      case Verdict.ALLOW:
        parts.push('Operation allowed.');
        break;
      case Verdict.CONFIRM:
        parts.push('Operation requires confirmation.');
        break;
      case Verdict.DENY:
        parts.push('Operation denied.');
        break;
    }

    parts.push(`Risk level: ${riskLevel}`);

    // Add blocking layer info if denied
    if (verdict === Verdict.DENY) {
      const blockingLayer = layerResults.find((r) => r.blocked);
      if (blockingLayer) {
        parts.push(`Blocked by: ${blockingLayer.name} — ${blockingLayer.reason}`);
      }
    }

    return parts.join(' ');
  }
}

/**
 * Get the user's home directory.
 */
const userHome = (() => {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.USERPROFILE || process.env.HOME || '';
  }
  return '';
})();

/**
 * Factory function to create a SecurityPipeline instance.
 */
export async function createSecurityPipeline(
  config: SecurityPipelineConfig = {}
): Promise<SecurityPipeline> {
  const pipeline = new SecurityPipeline(config);
  await pipeline.initialize();
  return pipeline;
}
