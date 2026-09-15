/**
 * @oa/security — Sanitizer layer (priority 50)
 * 
 * Output sanitization:
 * - MAC address redaction
 * - Workspace root replacement
 * - User home path replacement
 * - Custom pattern redaction
 * 
 * Runs first (lowest priority number) to clean output before other layers.
 */

import {
  ToolCall,
  SecurityContext,
  LayerResult,
  SecurityLayer,
  Verdict,
  RiskLevel,
  SanitizerConfig,
} from '../types';

/** Default sensitive patterns to redact */
const DEFAULT_PATTERNS: Array<{ pattern: RegExp; replacement: string; description: string }> = [
  // IPv4 addresses (preserve localhost)
  { pattern: /(?<!127\.0\.0\.1)(?<!localhost)\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, replacement: '[REDACTED_IP]', description: 'IP address' },

  // Email addresses
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[REDACTED_EMAIL]', description: 'Email address' },

  // AWS Access Key IDs
  { pattern: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g, replacement: '[REDACTED_AWS_KEY]', description: 'AWS access key' },

  // AWS Secret Access Key patterns
  { pattern: /aws_secret_access_key["'\s:=]+[A-Za-z0-9/+=]{40}/gi, replacement: 'aws_secret_access_key=[REDACTED]', description: 'AWS secret key' },

  // Generic API keys
  { pattern: /\b(api[_-]?key|apikey|token|secret)["'\s:=]+[A-Za-z0-9_\-]{16,64}\b/gi, replacement: '$1=[REDACTED]', description: 'API key/token' },

  // Private keys
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]', description: 'Private key' },

  // Credit card numbers (basic pattern)
  { pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b/g, replacement: '[REDACTED_CC]', description: 'Credit card number' },

  // Social Security Numbers
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED_SSN]', description: 'SSN' },

  // Phone numbers (US format)
  { pattern: /\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g, replacement: '[REDACTED_PHONE]', description: 'Phone number' },
];

/**
 * Sanitizer layer implementation.
 */
export class Sanitizer implements SecurityLayer {
  readonly name = 'Sanitizer';
  readonly priority = 50;
  private config: Required<SanitizerConfig>;

  constructor(config: SanitizerConfig = {}) {
    this.config = {
      extraPatterns: config.extraPatterns ?? [],
      redactMac: config.redactMac ?? true,
      redactWorkspace: config.redactWorkspace ?? true,
      redactHome: config.redactHome ?? true,
    };
  }

  /**
   * Check a tool call (sanitizer doesn't block, only modifies).
   */
  async check(toolCall: ToolCall, context: SecurityContext): Promise<LayerResult> {
    const startTime = Date.now();

    // Sanitize arguments
    const sanitizedArguments = this.sanitizeArguments(toolCall.arguments);

    // Sanitize command if present
    let sanitizedCommand = toolCall.command;
    if (sanitizedCommand) {
      sanitizedCommand = this.sanitizeText(sanitizedCommand);
    }

    const modified =
      JSON.stringify(sanitizedArguments) !== JSON.stringify(toolCall.arguments) ||
      sanitizedCommand !== toolCall.command;

    return {
      name: this.name,
      priority: this.priority,
      verdict: Verdict.ALLOW,
      riskLevel: RiskLevel.LOW,
      reason: modified ? 'Output sanitized' : 'No sanitization needed',
      blocked: false,
      elapsedMs: Date.now() - startTime,
    };
  }

  /**
   * Sanitize tool arguments.
   */
  sanitizeArguments(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        sanitized[key] = this.sanitizeText(value);
      } else if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value)) {
          sanitized[key] = value.map((item) =>
            typeof item === 'string' ? this.sanitizeText(item) : item
          );
        } else {
          sanitized[key] = this.sanitizeArguments(value as Record<string, unknown>);
        }
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Sanitize a text string.
   */
  sanitizeText(text: string): string {
    let sanitized = text;

    // MAC address redaction
    if (this.config.redactMac) {
      sanitized = this.redactMacAddresses(sanitized);
    }

    // Workspace root replacement
    if (this.config.redactWorkspace) {
      sanitized = this.redactWorkspaceRoot(sanitized);
    }

    // User home path replacement
    if (this.config.redactHome) {
      sanitized = this.redactUserHome(sanitized);
    }

    // Apply default patterns
    for (const pattern of DEFAULT_PATTERNS) {
      sanitized = sanitized.replace(pattern.pattern, pattern.replacement);
    }

    // Apply custom patterns
    for (const pattern of this.config.extraPatterns) {
      sanitized = sanitized.replace(pattern.pattern, pattern.replacement);
    }

    return sanitized;
  }

  /**
   * Redact MAC addresses.
   */
  private redactMacAddresses(text: string): string {
    // Standard MAC formats: XX:XX:XX:XX:XX:XX or XX-XX-XX-XX-XX-XX or XXXXXXXXXXXX
    const macPatterns = [
      /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g,
      /\b(?:[0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}\b/g,
      /\b[0-9A-Fa-f]{12}\b/g,
    ];

    let result = text;
    for (const pattern of macPatterns) {
      result = result.replace(pattern, '[REDACTED_MAC]');
    }
    return result;
  }

  /**
   * Redact workspace root path.
   */
  private redactWorkspaceRoot(text: string): string {
    // In production, this would use the actual workspace root from config
    // For now, use common patterns
    const workspacePatterns = [
      /\/Users\/[^\/\s]+/g,
      /\/home\/[^\/\s]+/g,
      /C:\\Users\\[^\\\s]+/g,
      /\/workspace\/[^\/\s]+/g,
      /\/projects\/[^\/\s]+/g,
    ];

    let result = text;
    for (const pattern of workspacePatterns) {
      result = result.replace(pattern, '[WORKSPACE]');
    }
    return result;
  }

  /**
   * Redact user home directory path.
   */
  private redactUserHome(text: string): string {
    const homePatterns = [
      /\~\/[^\s]*/g,
      /\$HOME/g,
      /%USERPROFILE%/g,
    ];

    let result = text;
    for (const pattern of homePatterns) {
      result = result.replace(pattern, '[HOME]');
    }
    return result;
  }

  /**
   * Create a layer result.
   */
  private createResult(
    verdict: Verdict,
    riskLevel: RiskLevel,
    reason: string,
    blocked: boolean,
    startTime: number
  ): LayerResult {
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
}
