/**
 * @oa/plugins — Risk Control Plugin (built-in)
 *
 * Adapted from the Ovolve pattern. Intercepts tool calls before execution
 * and evaluates risk level. High-risk operations may require confirmation,
 * be logged for audit, or blocked entirely based on policy.
 */

import {
  IPlugin,
  PluginManifest,
  HookPoint,
  HookRegistry,
  PluginContext,
  HookHandler,
  HookControl,
  RiskLevel,
} from '../types';

/**
 * Configuration for the risk control plugin.
 */
export interface RiskControlConfig {
  /** Maximum risk level allowed without confirmation. */
  maxAllowedRisk: RiskLevel;
  /** Whether to block CRITICAL operations entirely. */
  blockCritical: boolean;
  /** Custom risk overrides for specific tool names. */
  toolRiskOverrides: Record<string, RiskLevel>;
  /** Callback invoked when a high-risk tool is about to execute. */
  onHighRisk?: (toolName: string, riskLevel: RiskLevel, context: PluginContext) => Promise<boolean> | boolean;
  /** Callback for audit logging. */
  onAudit?: (entry: AuditEntry) => void;
}

/**
 * Audit entry recorded for high-risk operations.
 */
export interface AuditEntry {
  timestamp: Date;
  toolName: string;
  riskLevel: RiskLevel;
  sessionId: string;
  agentId: string;
  userId?: string;
  decision: 'allowed' | 'blocked' | 'confirmed';
  reason?: string;
}

/**
 * Payload for PRE_TOOL_USE hook.
 */
export interface ToolUsePayload {
  toolName: string;
  args: Record<string, unknown>;
  scope?: string;
}

/**
 * Risk ordering for comparison.
 */
const RISK_ORDER: Record<RiskLevel, number> = {
  [RiskLevel.LOW]: 0,
  [RiskLevel.MEDIUM]: 1,
  [RiskLevel.HIGH]: 2,
  [RiskLevel.CRITICAL]: 3,
};

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: RiskControlConfig = {
  maxAllowedRisk: RiskLevel.HIGH,
  blockCritical: true,
  toolRiskOverrides: {},
};

/**
 * Risk control plugin implementation.
 */
export class RiskControlPlugin implements IPlugin {
  readonly manifest: PluginManifest = {
    name: 'risk-control',
    version: '1.0.0',
    description: 'Evaluates and controls risk levels for tool operations',
    author: 'OvolveAgent',
    hookPoints: [HookPoint.PRE_TOOL_USE],
    riskLevel: RiskLevel.LOW,
  };

  private config: RiskControlConfig;
  private auditLog: AuditEntry[] = [];

  constructor(config: Partial<RiskControlConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register hooks with the plugin system.
   */
  register(registry: HookRegistry, _context: PluginContext): void {
    const handler: HookHandler<ToolUsePayload> = async (payload, ctx) => {
      return this.evaluateRisk(payload, ctx);
    };

    // Register with high priority (runs early).
    registry.on(HookPoint.PRE_TOOL_USE, handler, 10);
  }

  /**
   * Evaluate the risk of a tool call and potentially block it.
   */
  private async evaluateRisk(
    payload: ToolUsePayload,
    context: PluginContext
  ): Promise<ToolUsePayload | HookControl> {
    const riskLevel = this.getRiskLevel(payload.toolName);

    // CRITICAL operations are blocked entirely if configured.
    if (riskLevel === RiskLevel.CRITICAL && this.config.blockCritical) {
      this.recordAudit({
        timestamp: new Date(),
        toolName: payload.toolName,
        riskLevel,
        sessionId: context.sessionId,
        agentId: context.agentId,
        userId: context.userId,
        decision: 'blocked',
        reason: 'CRITICAL operations are blocked by policy',
      });

      return {
        blocked: true,
        reason: `Tool "${payload.toolName}" is classified as CRITICAL risk and is blocked by policy.`,
      };
    }

    // Check if risk exceeds the allowed threshold.
    if (RISK_ORDER[riskLevel] > RISK_ORDER[this.config.maxAllowedRisk]) {
      // Attempt confirmation callback.
      if (this.config.onHighRisk) {
        const confirmed = await this.config.onHighRisk(
          payload.toolName,
          riskLevel,
          context
        );

        this.recordAudit({
          timestamp: new Date(),
          toolName: payload.toolName,
          riskLevel,
          sessionId: context.sessionId,
          agentId: context.agentId,
          userId: context.userId,
          decision: confirmed ? 'confirmed' : 'blocked',
          reason: confirmed ? 'User confirmed high-risk operation' : 'User denied high-risk operation',
        });

        if (!confirmed) {
          return {
            blocked: true,
            reason: `High-risk operation "${payload.toolName}" was denied.`,
          };
        }
      } else {
        // No confirmation callback — block by default.
        this.recordAudit({
          timestamp: new Date(),
          toolName: payload.toolName,
          riskLevel,
          sessionId: context.sessionId,
          agentId: context.agentId,
          userId: context.userId,
          decision: 'blocked',
          reason: `Risk level ${riskLevel} exceeds maximum allowed ${this.config.maxAllowedRisk}`,
        });

        return {
          blocked: true,
          reason: `Tool "${payload.toolName}" risk level (${riskLevel}) exceeds maximum allowed (${this.config.maxAllowedRisk}).`,
        };
      }
    }

    // Log audit for high-risk even if allowed.
    if (riskLevel === RiskLevel.HIGH) {
      this.recordAudit({
        timestamp: new Date(),
        toolName: payload.toolName,
        riskLevel,
        sessionId: context.sessionId,
        agentId: context.agentId,
        userId: context.userId,
        decision: 'allowed',
        reason: 'Within allowed risk threshold',
      });
    }

    return payload;
  }

  /**
   * Determine the risk level for a tool.
   */
  private getRiskLevel(toolName: string): RiskLevel {
    // Check overrides first.
    if (this.config.toolRiskOverrides[toolName]) {
      return this.config.toolRiskOverrides[toolName];
    }

    // MCP tools default to MEDIUM.
    if (toolName.startsWith('mcp__')) {
      return RiskLevel.MEDIUM;
    }

    // Heuristic classification based on tool name patterns.
    const lowerName = toolName.toLowerCase();

    if (
      lowerName.includes('delete') ||
      lowerName.includes('remove') ||
      lowerName.includes('destroy') ||
      lowerName.includes('kill') ||
      lowerName.includes('force')
    ) {
      return RiskLevel.HIGH;
    }

    if (
      lowerName.includes('exec') ||
      lowerName.includes('shell') ||
      lowerName.includes('command') ||
      lowerName.includes('terminal')
    ) {
      return RiskLevel.HIGH;
    }

    if (
      lowerName.includes('write') ||
      lowerName.includes('edit') ||
      lowerName.includes('modify') ||
      lowerName.includes('update')
    ) {
      return RiskLevel.MEDIUM;
    }

    if (
      lowerName.includes('read') ||
      lowerName.includes('search') ||
      lowerName.includes('find') ||
      lowerName.includes('list') ||
      lowerName.includes('get')
    ) {
      return RiskLevel.LOW;
    }

    return RiskLevel.MEDIUM;
  }

  /**
   * Record an audit entry.
   */
  private recordAudit(entry: AuditEntry): void {
    this.auditLog.push(entry);
    if (this.config.onAudit) {
      this.config.onAudit(entry);
    }
  }

  /**
   * Get the audit log.
   */
  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }

  /**
   * Clear the audit log.
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }
}

/**
 * Factory function to create a RiskControlPlugin.
 */
export function createRiskControlPlugin(config?: Partial<RiskControlConfig>): RiskControlPlugin {
  return new RiskControlPlugin(config);
}
