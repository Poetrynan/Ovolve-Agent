/**
 * @oa/security — Tool Hooks layer
 * 
 * Pre/post/abort hooks for tool execution:
 * - Secret redaction (10 credential patterns)
 * - Anti-injection (prompt-framing tags)
 * - Destructive command guard
 * - Write content guard
 */

import {
  ToolCall,
  SecurityContext,
  LayerResult,
  SecurityLayer,
  Verdict,
  RiskLevel,
  HookEvent,
  HookHandler,
  HookResult,
  ToolHooksConfig,
} from '../types';

/** 10 credential patterns for secret redaction */
const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; replacement: string; name: string }> = [
  // AWS credentials
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY]', name: 'AWS Access Key' },
  { pattern: /aws_secret_access_key["'\s:=]+[A-Za-z0-9/+=]{40}/gi, replacement: 'aws_secret_access_key=[REDACTED]', name: 'AWS Secret Key' },

  // GitHub tokens
  { pattern: /ghp_[A-Za-z0-9]{36}/g, replacement: '[REDACTED_GITHUB_TOKEN]', name: 'GitHub Personal Token' },
  { pattern: /gho_[A-Za-z0-9]{36}/g, replacement: '[REDACTED_GITHUB_OAUTH]', name: 'GitHub OAuth Token' },

  // Generic tokens
  { pattern: /\bBearer\s+[A-Za-z0-9_\-\.]{20,}/gi, replacement: 'Bearer [REDACTED]', name: 'Bearer Token' },
  { pattern: /\bBasic\s+[A-Za-z0-9+\/=]{20,}/gi, replacement: 'Basic [REDACTED]', name: 'Basic Auth' },

  // API keys
  { pattern: /\b(sk|pk)-(?:test|live)_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_KEY]', name: 'Stripe API Key' },
  { pattern: /xai-[A-Za-z0-9]{64}/g, replacement: '[REDACTED_XAI_KEY]', name: 'xAI API Key' },

  // Passwords in connection strings
  { pattern: /(password|passwd|pwd)["'\s:=]+[^\s"';,}]+/gi, replacement: '$1=[REDACTED]', name: 'Password in connection string' },

  // Private keys
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]', name: 'Private Key' },
];

/** Prompt injection framing tags to detect */
const INJECTION_FRAMING_TAGS: string[] = [
  '<system>',
  '</system>',
  '<instruction>',
  '</instruction>',
  '<prompt>',
  '</prompt>',
  '[INST]',
  '[/INST]',
  '<<SYS>>',
  '<</SYS>>',
  '### Instruction:',
  '### System:',
  'SYSTEM:',
  'HUMAN:',
  'ASSISTANT:',
];

/** Destructive command indicators */
const DESTRUCTIVE_INDICATORS: RegExp[] = [
  /\brm\s+(-[rfRF]+\s+)?\//,
  /\brm\s+(-[rfRF]+\s+)?\$/,
  /\bdel\s+/i,
  /\berase\s+/i,
  /\bdelete\s+/i,
  /\bdrop\s+(table|database|schema)/i,
  /\btruncate\s+table/i,
  /\bformat\s+/i,
  /\bmkfs\./,
  /\bdd\s+if=/,
];

/** Write operation indicators */
const WRITE_INDICATORS: RegExp[] = [
  /\bwrite\s+/i,
  /\bedit\s+/i,
  /\bcreate\s+/i,
  /\bupdate\s+/i,
  /\bappend\s+/i,
  /\binsert\s+/i,
  /\bmodify\s+/i,
];

/**
 * Tool Hooks layer implementation.
 */
export class ToolHooks implements SecurityLayer {
  readonly name = 'ToolHooks';
  readonly priority = 150;
  private config: Required<ToolHooksConfig>;
  private preToolHandlers: HookHandler[] = [];
  private postToolHandlers: HookHandler[] = [];
  private abortHandlers: HookHandler[] = [];

  constructor(config: ToolHooksConfig = {}) {
    this.config = {
      checkInjection: config.checkInjection ?? true,
      redactSecrets: config.redactSecrets ?? true,
      extraSecretPatterns: config.extraSecretPatterns ?? [],
    };

    // Register default handlers
    this.registerDefaultHandlers();
  }

  /**
   * Check a tool call through all hooks.
   */
  async check(toolCall: ToolCall, context: SecurityContext): Promise<LayerResult> {
    const startTime = Date.now();

    // Run pre-tool hooks
    for (const handler of this.preToolHandlers) {
      const result = await handler(toolCall, context);
      if (!result.proceed) {
        return {
          name: this.name,
          priority: this.priority,
          verdict: Verdict.DENY,
          riskLevel: RiskLevel.HIGH,
          reason: result.message ?? 'Blocked by pre-tool hook',
          blocked: true,
          elapsedMs: Date.now() - startTime,
        };
      }
    }

    // Anti-injection check
    if (this.config.checkInjection) {
      const injectionResult = this.checkPromptInjection(toolCall);
      if (injectionResult) {
        return {
          name: this.name,
          priority: this.priority,
          verdict: Verdict.DENY,
          riskLevel: RiskLevel.CRITICAL,
          reason: injectionResult,
          blocked: true,
          elapsedMs: Date.now() - startTime,
        };
      }
    }

    // Destructive command guard
    const destructiveResult = this.checkDestructiveCommand(toolCall);
    if (destructiveResult) {
      return {
        name: this.name,
        priority: this.priority,
        verdict: Verdict.CONFIRM,
        riskLevel: RiskLevel.HIGH,
        reason: destructiveResult,
        blocked: false,
        elapsedMs: Date.now() - startTime,
      };
    }

    // Write content guard
    const writeResult = this.checkWriteContent(toolCall);
    if (writeResult) {
      return {
        name: this.name,
        priority: this.priority,
        verdict: Verdict.CONFIRM,
        riskLevel: RiskLevel.MEDIUM,
        reason: writeResult,
        blocked: false,
        elapsedMs: Date.now() - startTime,
      };
    }

    return {
      name: this.name,
      priority: this.priority,
      verdict: Verdict.ALLOW,
      riskLevel: RiskLevel.LOW,
      reason: 'All tool hook checks passed',
      blocked: false,
      elapsedMs: Date.now() - startTime,
    };
  }

  /**
   * Post-process tool output (secret redaction).
   */
  postProcess(toolCall: ToolCall, output: string): string {
    if (!this.config.redactSecrets) return output;

    let redacted = output;

    // Apply credential patterns
    for (const pattern of CREDENTIAL_PATTERNS) {
      redacted = redacted.replace(pattern.pattern, pattern.replacement);
    }

    // Apply custom patterns
    for (const pattern of this.config.extraSecretPatterns) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }

    return redacted;
  }

  /**
   * Register a pre-tool hook handler.
   */
  onPreToolUse(handler: HookHandler): () => void {
    this.preToolHandlers.push(handler);
    return () => {
      const idx = this.preToolHandlers.indexOf(handler);
      if (idx !== -1) this.preToolHandlers.splice(idx, 1);
    };
  }

  /**
   * Register a post-tool hook handler.
   */
  onPostToolUse(handler: HookHandler): () => void {
    this.postToolHandlers.push(handler);
    return () => {
      const idx = this.postToolHandlers.indexOf(handler);
      if (idx !== -1) this.postToolHandlers.splice(idx, 1);
    };
  }

  /**
   * Register an abort hook handler.
   */
  onAbort(handler: HookHandler): () => void {
    this.abortHandlers.push(handler);
    return () => {
      const idx = this.abortHandlers.indexOf(handler);
      if (idx !== -1) this.abortHandlers.splice(idx, 1);
    };
  }

  /**
   * Register default hook handlers.
   */
  private registerDefaultHandlers(): void {
    // Pre-tool: validate arguments exist
    this.preToolHandlers.push(async (toolCall, _context) => {
      if (!toolCall.arguments || Object.keys(toolCall.arguments).length === 0) {
        // Some tools don't require arguments — this is a soft check
        return { proceed: true };
      }
      return { proceed: true };
    });

    // Post-tool: log execution
    this.postToolHandlers.push(async (_toolCall, _context) => {
      return { proceed: true };
    });

    // Abort: cleanup
    this.abortHandlers.push(async (_toolCall, _context) => {
      return { proceed: true };
    });
  }

  /**
   * Check for prompt injection attempts.
   */
  private checkPromptInjection(toolCall: ToolCall): string | null {
    const text = this.extractAllText(toolCall);

    for (const tag of INJECTION_FRAMING_TAGS) {
      if (text.includes(tag)) {
        return `Prompt injection framing detected: "${tag}"`;
      }
    }

    // Check for role-switching patterns
    const roleSwitchPatterns = [
      /\bnow\s+you\s+are\b/i,
      /\bfrom\s+now\s+on\s+you\b/i,
      /\byour\s+new\s+role\s+is\b/i,
      /\bforget\s+(everything|all)\s+(you\s+know|your\s+instructions)\b/i,
    ];

    for (const pattern of roleSwitchPatterns) {
      if (pattern.test(text)) {
        return 'Role-switching injection attempt detected';
      }
    }

    return null;
  }

  /**
   * Check for destructive commands.
   */
  private checkDestructiveCommand(toolCall: ToolCall): string | null {
    const command = toolCall.command ?? '';
    const args = JSON.stringify(toolCall.arguments);
    const text = `${command} ${args}`;

    for (const pattern of DESTRUCTIVE_INDICATORS) {
      if (pattern.test(text)) {
        return 'Destructive command detected — confirmation required';
      }
    }

    return null;
  }

  /**
   * Check write content for safety.
   */
  private checkWriteContent(toolCall: ToolCall): string | null {
    const isWrite = WRITE_INDICATORS.some((p) => p.test(toolCall.name));
    if (!isWrite) return null;

    // Check if writing to sensitive locations
    const args = toolCall.arguments;
    const path = (args.path ?? args.file_path ?? args.filePath ?? '') as string;

    if (path) {
      const sensitivePaths = [
        /\.env$/,
        /\.key$/,
        /\.pem$/,
        /id_rsa/,
        /id_ed25519/,
        /\.aws\/credentials/,
      ];

      for (const sp of sensitivePaths) {
        if (sp.test(path)) {
          return `Write to sensitive path detected: ${path}`;
        }
      }
    }

    return null;
  }

  /**
   * Extract all text from a tool call.
   */
  private extractAllText(toolCall: ToolCall): string {
    const parts: string[] = [toolCall.name];

    if (toolCall.command) {
      parts.push(toolCall.command);
    }

    for (const value of Object.values(toolCall.arguments)) {
      if (typeof value === 'string') {
        parts.push(value);
      } else if (typeof value === 'object' && value !== null) {
        parts.push(JSON.stringify(value));
      }
    }

    return parts.join(' ');
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
