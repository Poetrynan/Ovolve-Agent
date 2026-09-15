/**
 * @oa/plugins — Security Pipeline Plugin (built-in)
 *
 * Provides a security layer that sanitizes inputs, validates outputs,
 * and enforces access controls. Runs before and after tool execution
 * to prevent injection attacks and data leaks.
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
  HealthStatus,
} from '../types';

/**
 * Security rule for input validation.
 */
export interface SecurityRule {
  name: string;
  pattern: RegExp;
  action: 'block' | 'warn' | 'sanitize';
  message: string;
  /** Optional sanitizer function for 'sanitize' action. */
  sanitizer?: (input: string) => string;
}

/**
 * Configuration for the security plugin.
 */
export interface SecurityConfig {
  /** Whether to enable input sanitization. */
  enableInputSanitization: boolean;
  /** Whether to enable output validation. */
  enableOutputValidation: boolean;
  /** Custom security rules. */
  rules: SecurityRule[];
  /** Patterns that indicate potential prompt injection. */
  injectionPatterns: RegExp[];
  /** Maximum allowed input length. */
  maxInputLength: number;
  /** Maximum allowed output length. */
  maxOutputLength: number;
  /** Whether to detect and block data exfiltration patterns. */
  preventDataExfiltration: boolean;
  /** Callback for security events. */
  onSecurityEvent?: (event: SecurityEvent) => void;
}

/**
 * Security event record.
 */
export interface SecurityEvent {
  timestamp: Date;
  type: 'injection_detected' | 'input_blocked' | 'output_blocked' | 'sanitization' | 'length_exceeded';
  toolName?: string;
  sessionId: string;
  agentId: string;
  details: string;
  action: 'blocked' | 'warned' | 'sanitized';
}

/**
 * Payload for tool use hooks.
 */
export interface ToolUsePayload {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
}

/**
 * Default injection detection patterns.
 */
const DEFAULT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(previous|above|all)\s+instructions/i,
  /you\s+are\s+now\s+(a|an|the)/i,
  /system\s*:\s*you\s+are/i,
  /<\s*script\s*>/i,
  /\{\{\s*.*\s*\}\}/,  // Template injection
  /\$\{.*\}/,           // Shell interpolation
  /__\w+__/,            // Python dunder access
  /password\s*[:=]/i,
  /secret\s*[:=]/i,
  /api[_\s]?key\s*[:=]/i,
];

/**
 * Default security rules.
 */
const DEFAULT_RULES: SecurityRule[] = [
  {
    name: 'no-shell-injection',
    pattern: /[;&|`$(){}[\]]/,
    action: 'sanitize',
    message: 'Potential shell metacharacters detected',
    sanitizer: (input) => input.replace(/[;&|`$(){}[\]]/g, ''),
  },
  {
    name: 'no-path-traversal',
    pattern: /\.\.\//,
    action: 'block',
    message: 'Path traversal attempt detected',
  },
  {
    name: 'no-null-bytes',
    pattern: /\0/,
    action: 'block',
    message: 'Null byte injection detected',
  },
];

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: SecurityConfig = {
  enableInputSanitization: true,
  enableOutputValidation: true,
  rules: DEFAULT_RULES,
  injectionPatterns: DEFAULT_INJECTION_PATTERNS,
  maxInputLength: 100000,
  maxOutputLength: 500000,
  preventDataExfiltration: true,
};

/**
 * Security pipeline plugin implementation.
 */
export class SecurityPlugin implements IPlugin {
  readonly manifest: PluginManifest = {
    name: 'security',
    version: '1.0.0',
    description: 'Security pipeline for input sanitization and output validation',
    author: 'OvolveAgent',
    hookPoints: [HookPoint.PRE_TOOL_USE, HookPoint.POST_TOOL_USE, HookPoint.PRE_LLM_REQUEST],
    riskLevel: RiskLevel.LOW,
  };

  private config: SecurityConfig;
  private securityEvents: SecurityEvent[] = [];

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      rules: [...DEFAULT_RULES, ...(config.rules || [])],
      injectionPatterns: [...DEFAULT_INJECTION_PATTERNS, ...(config.injectionPatterns || [])],
    };
  }

  /**
   * Register hooks with the plugin system.
   */
  register(registry: HookRegistry, _context: PluginContext): void {
    // Pre-tool-use: sanitize and validate inputs.
    const preToolHandler: HookHandler<ToolUsePayload> = async (payload, ctx) => {
      return this.validateInput(payload, ctx);
    };
    registry.on(HookPoint.PRE_TOOL_USE, preToolHandler, 1);

    // Post-tool-use: validate outputs.
    const postToolHandler: HookHandler<ToolUsePayload> = async (payload, ctx) => {
      return this.validateOutput(payload, ctx);
    };
    registry.on(HookPoint.POST_TOOL_USE, postToolHandler, 1);

    // Pre-LLM-request: check for prompt injection in messages.
    const preLLMHandler: HookHandler<{ messages: Array<{ role: string; content: string }> }> = async (payload, ctx) => {
      return this.checkPromptInjection(payload, ctx);
    };
    registry.on(HookPoint.PRE_LLM_REQUEST, preLLMHandler, 1);
  }

  /**
   * Validate and sanitize tool input.
   */
  private async validateInput(
    payload: ToolUsePayload,
    context: PluginContext
  ): Promise<ToolUsePayload | HookControl> {
    const { toolName, args } = payload;

    // Check input length.
    const argsString = JSON.stringify(args);
    if (argsString.length > this.config.maxInputLength) {
      this.recordEvent({
        timestamp: new Date(),
        type: 'length_exceeded',
        toolName,
        sessionId: context.sessionId,
        agentId: context.agentId,
        details: `Input length ${argsString.length} exceeds maximum ${this.config.maxInputLength}`,
        action: 'blocked',
      });

      return {
        blocked: true,
        reason: `Input exceeds maximum allowed length (${this.config.maxInputLength} characters)`,
      };
    }

    // Apply security rules to string arguments.
    if (this.config.enableInputSanitization) {
      const sanitizedArgs: Record<string, unknown> = {};
      let wasSanitized = false;
      let wasBlocked = false;
      let blockReason = '';

      for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string') {
          const result = this.applyRules(value, toolName, context);
          if (result.blocked) {
            wasBlocked = true;
            blockReason = result.reason;
            break;
          }
          sanitizedArgs[key] = result.value;
          if (result.wasSanitized) {
            wasSanitized = true;
          }
        } else {
          sanitizedArgs[key] = value;
        }
      }

      if (wasBlocked) {
        return {
          blocked: true,
          reason: blockReason,
        };
      }

      if (wasSanitized) {
        this.recordEvent({
          timestamp: new Date(),
          type: 'sanitization',
          toolName,
          sessionId: context.sessionId,
          agentId: context.agentId,
          details: 'Input was sanitized by security rules',
          action: 'sanitized',
        });
        return { ...payload, args: sanitizedArgs };
      }
    }

    return payload;
  }

  /**
   * Validate tool output.
   */
  private async validateOutput(
    payload: ToolUsePayload,
    context: PluginContext
  ): Promise<ToolUsePayload | HookControl> {
    if (!this.config.enableOutputValidation) {
      return payload;
    }

    const { toolName, result } = payload;
    if (result === undefined || result === null) {
      return payload;
    }

    const resultString = typeof result === 'string' ? result : JSON.stringify(result);

    // Check output length.
    if (resultString.length > this.config.maxOutputLength) {
      this.recordEvent({
        timestamp: new Date(),
        type: 'length_exceeded',
        toolName,
        sessionId: context.sessionId,
        agentId: context.agentId,
        details: `Output length ${resultString.length} exceeds maximum ${this.config.maxOutputLength}`,
        action: 'blocked',
      });

      return {
        ...payload,
        result: resultString.slice(0, this.config.maxOutputLength) + '\n... [TRUNCATED BY SECURITY POLICY]',
      };
    }

    // Check for data exfiltration patterns.
    if (this.config.preventDataExfiltration) {
      const exfilPatterns = [
        /\b\d{16}\b/,  // Credit card-like
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,  // Email
        /\b\d{3}-\d{2}-\d{4}\b/,  // SSN-like
      ];

      for (const pattern of exfilPatterns) {
        if (pattern.test(resultString)) {
          this.recordEvent({
            timestamp: new Date(),
            type: 'output_blocked',
            toolName,
            sessionId: context.sessionId,
            agentId: context.agentId,
            details: 'Potential sensitive data detected in output',
            action: 'warned',
          });
          // Don't block, but flag it.
          break;
        }
      }
    }

    return payload;
  }

  /**
   * Check LLM request messages for prompt injection.
   */
  private async checkPromptInjection(
    payload: { messages: Array<{ role: string; content: string }> },
    context: PluginContext
  ): Promise<typeof payload | HookControl> {
    for (const message of payload.messages) {
      for (const pattern of this.config.injectionPatterns) {
        if (pattern.test(message.content)) {
          this.recordEvent({
            timestamp: new Date(),
            type: 'injection_detected',
            sessionId: context.sessionId,
            agentId: context.agentId,
            details: `Potential prompt injection detected: ${pattern.source}`,
            action: 'blocked',
          });

          return {
            blocked: true,
            reason: 'Potential prompt injection detected in request. Operation blocked for safety.',
          };
        }
      }
    }

    return payload;
  }

  /**
   * Apply security rules to a string value.
   */
  private applyRules(
    value: string,
    toolName: string,
    context: PluginContext
  ): { value: string; blocked: boolean; reason: string; wasSanitized: boolean } {
    let result = value;
    let wasSanitized = false;

    for (const rule of this.config.rules) {
      if (rule.pattern.test(result)) {
        switch (rule.action) {
          case 'block':
            this.recordEvent({
              timestamp: new Date(),
              type: 'input_blocked',
              toolName,
              sessionId: context.sessionId,
              agentId: context.agentId,
              details: `Rule "${rule.name}" triggered: ${rule.message}`,
              action: 'blocked',
            });
            return {
              value: result,
              blocked: true,
              reason: `Security rule "${rule.name}" blocked input: ${rule.message}`,
              wasSanitized,
            };

          case 'sanitize':
            if (rule.sanitizer) {
              result = rule.sanitizer(result);
              wasSanitized = true;
              this.recordEvent({
                timestamp: new Date(),
                type: 'sanitization',
                toolName,
                sessionId: context.sessionId,
                agentId: context.agentId,
                details: `Rule "${rule.name}" sanitized input: ${rule.message}`,
                action: 'sanitized',
              });
            }
            break;

          case 'warn':
            this.recordEvent({
              timestamp: new Date(),
              type: 'input_blocked',
              toolName,
              sessionId: context.sessionId,
              agentId: context.agentId,
              details: `Rule "${rule.name}" warning: ${rule.message}`,
              action: 'warned',
            });
            break;
        }
      }
    }

    return { value: result, blocked: false, reason: '', wasSanitized };
  }

  /**
   * Record a security event.
   */
  private recordEvent(event: SecurityEvent): void {
    this.securityEvents.push(event);
    if (this.config.onSecurityEvent) {
      this.config.onSecurityEvent(event);
    }
  }

  /**
   * Get all recorded security events.
   */
  getSecurityEvents(): SecurityEvent[] {
    return [...this.securityEvents];
  }

  /**
   * Clear security event log.
   */
  clearSecurityEvents(): void {
    this.securityEvents = [];
  }

  /**
   * Add a custom security rule at runtime.
   */
  addRule(rule: SecurityRule): void {
    this.config.rules.push(rule);
  }

  /**
   * Remove a security rule by name.
   */
  removeRule(name: string): boolean {
    const index = this.config.rules.findIndex((r) => r.name === name);
    if (index !== -1) {
      this.config.rules.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Health check.
   */
  async onHealthCheck(): Promise<HealthStatus> {
    return {
      healthy: true,
      message: `Security pipeline active with ${this.config.rules.length} rules`,
      details: {
        rulesCount: this.config.rules.length,
        eventsCount: this.securityEvents.length,
        inputSanitization: this.config.enableInputSanitization,
        outputValidation: this.config.enableOutputValidation,
      },
    };
  }
}

/**
 * Factory function to create a SecurityPlugin.
 */
export function createSecurityPlugin(config?: Partial<SecurityConfig>): SecurityPlugin {
  return new SecurityPlugin(config);
}
