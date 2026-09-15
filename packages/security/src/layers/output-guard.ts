/**
 * @oa/security — Output Guard layer (priority 200)
 * 
 * Anti-leakage protection:
 * - 13 extraction attempt patterns
 * - Non-repeating refusal pool (14 phrases)
 * - Zero-width character normalization
 * - Dark tooltips in both themes
 */

import {
  ToolCall,
  SecurityContext,
  LayerResult,
  SecurityLayer,
  Verdict,
  RiskLevel,
  OutputGuardConfig,
} from '../types';

/** 13 extraction attempt patterns */
const EXTRACTION_PATTERNS: Array<{ pattern: RegExp; description: string; riskLevel: RiskLevel }> = [
  // Direct file reads of sensitive files
  { pattern: /\b(read|cat|open|show|display|print|echo|type)\s+.*\.(env|key|pem|p12|pfx|keystore)/i, description: 'Attempt to read sensitive files', riskLevel: RiskLevel.CRITICAL },
  { pattern: /\b(read|cat|open|show|display|print|echo|type)\s+.*\/(etc\/passwd|etc\/shadow|ssh\/id_|aws\/credentials)/i, description: 'Attempt to read system credentials', riskLevel: RiskLevel.CRITICAL },

  // Memory extraction attempts
  { pattern: /\b(show|display|print|echo|output|dump|export)\s+.*(memory|context|system\s*prompt|instructions)/i, description: 'Attempt to extract system context', riskLevel: RiskLevel.CRITICAL },
  { pattern: /\bwhat\s+(are|is)\s+(your|the)\s+(instructions|system\s*prompt|rules|constraints)/i, description: 'Direct system prompt query', riskLevel: RiskLevel.HIGH },
  { pattern: /\b(repeat|recite|output|show)\s+(the|your|above|previous)\s+(prompt|instructions|context)/i, description: 'Prompt repetition request', riskLevel: RiskLevel.HIGH },

  // Encoding/obfuscation attempts
  { pattern: /\b(base64|hex|rot13|url\s*encode|encode)\s+(the|your|this|above)\s+(prompt|instructions|context)/i, description: 'Encoded extraction attempt', riskLevel: RiskLevel.CRITICAL },
  { pattern: /\b(translate|convert)\s+(the|your)\s+(prompt|instructions)\s+(to|into)\s+(base64|hex|binary)/i, description: 'Translation extraction attempt', riskLevel: RiskLevel.CRITICAL },

  // Social engineering
  { pattern: /\b(ignore|disregard|forget|override)\s+(previous|above|all|your)\s+(instructions|rules|constraints)/i, description: 'Instruction override attempt', riskLevel: RiskLevel.CRITICAL },
  { pattern: /\b(pretend|act|behave|roleplay)\s+(you\s+are|to\s+be|as)\s+(not\s+)?(bound|constrained|restricted|limited)/i, description: 'Roleplay bypass attempt', riskLevel: RiskLevel.HIGH },
  { pattern: /\b(hypothetically|imagine|suppose|in\s+a\s+scenario)\s+.*\b(ignore|bypass|break|violate)\b/i, description: 'Hypothetical bypass attempt', riskLevel: RiskLevel.HIGH },

  // Token/attention manipulation
  { pattern: /\b(fill|pad|repeat)\s+.*\b(token|character|word)\s+(count|limit|maximum)/i, description: 'Token manipulation attempt', riskLevel: RiskLevel.MEDIUM },
  { pattern: /\b(start|begin|end)\s+.*\b(with|using)\b.*["'].{50,}["']/i, description: 'Long string injection', riskLevel: RiskLevel.MEDIUM },

  // Multi-turn extraction
  { pattern: /\b(remember|save|store)\s+(this|the\s+following)\s+(for|to)\s+(later|future|next)/i, description: 'Multi-turn context storage', riskLevel: RiskLevel.MEDIUM },
];

/** 14 non-repeating refusal phrases */
const REFUSAL_PHRASES: string[] = [
  'I cannot fulfill that request.',
  'I am not able to help with that specific request.',
  'That request falls outside what I can assist with.',
  'I must decline that particular request.',
  'I cannot comply with that instruction.',
  'That action is not something I can perform.',
  'I am unable to process that request.',
  'That request cannot be fulfilled at this time.',
  'I cannot assist with that type of request.',
  'That falls outside my operational parameters.',
  'I must respectfully decline that request.',
  'That request is outside my capabilities.',
  'I cannot execute that particular instruction.',
  'That type of request cannot be accommodated.',
];

/** Zero-width and invisible characters to normalize */
const ZERO_WIDTH_CHARS = [
  '\u200B', // Zero-width space
  '\u200C', // Zero-width non-joiner
  '\u200D', // Zero-width joiner
  '\u200E', // Left-to-right mark
  '\u200F', // Right-to-left mark
  '\u2060', // Word joiner
  '\u2061', // Function application
  '\u2062', // Invisible times
  '\u2063', // Invisible separator
  '\u2064', // Invisible plus
  '\uFEFF', // Zero-width no-break space (BOM)
  '\u00AD', // Soft hyphen
  '\u034F', // Combining grapheme joiner
  '\u180E', // Mongolian vowel separator
  '\u115F', // Hangul choseong filler
  '\u1160', // Hangul jungseong filler
  '\u3164', // Hangul filler
  '\uFFA0', // Halfwidth hangul filler
];

/**
 * Output Guard layer implementation.
 */
export class OutputGuard implements SecurityLayer {
  readonly name = 'OutputGuard';
  readonly priority = 200;
  private config: Required<OutputGuardConfig>;
  private lastRefusalIndex = -1;

  constructor(config: OutputGuardConfig = {}) {
    this.config = {
      extraPatterns: config.extraPatterns ?? [],
      normalizeZeroWidth: config.normalizeZeroWidth ?? true,
    };
  }

  /**
   * Check a tool call for extraction attempts.
   */
  async check(toolCall: ToolCall, context: SecurityContext): Promise<LayerResult> {
    const startTime = Date.now();

    // Get the text to analyze
    const text = this.extractText(toolCall);
    if (!text) {
      return this.createResult(Verdict.ALLOW, RiskLevel.LOW, 'No text to analyze', false, startTime);
    }

    // Normalize zero-width characters
    const normalizedText = this.config.normalizeZeroWidth
      ? this.normalizeZeroWidth(text)
      : text;

    // Check all extraction patterns
    const allPatterns = [
      ...EXTRACTION_PATTERNS,
      ...this.config.extraPatterns.map((p) => ({
        pattern: p,
        description: 'Custom extraction pattern',
        riskLevel: RiskLevel.HIGH,
      })),
    ];

    for (const pattern of allPatterns) {
      if (pattern.pattern.test(normalizedText)) {
        const refusal = this.getNextRefusal();
        return this.createResult(
          Verdict.DENY,
          pattern.riskLevel,
          `Extraction attempt detected: ${pattern.description}. ${refusal}`,
          true,
          startTime
        );
      }
    }

    return this.createResult(Verdict.ALLOW, RiskLevel.LOW, 'No extraction patterns detected', false, startTime);
  }

  /**
   * Sanitize output text (for post-processing).
   */
  sanitizeOutput(text: string): string {
    let sanitized = text;

    // Normalize zero-width characters
    if (this.config.normalizeZeroWidth) {
      sanitized = this.normalizeZeroWidth(sanitized);
    }

    return sanitized;
  }

  /**
   * Extract text content from a tool call for analysis.
   */
  private extractText(toolCall: ToolCall): string {
    const parts: string[] = [];

    // Add command if present
    if (toolCall.command) {
      parts.push(toolCall.command);
    }

    // Add argument values
    const args = toolCall.arguments;
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        parts.push(value);
      } else if (typeof value === 'object' && value !== null) {
        parts.push(JSON.stringify(value));
      }
    }

    return parts.join(' ');
  }

  /**
   * Normalize zero-width characters.
   */
  private normalizeZeroWidth(text: string): string {
    let normalized = text;
    for (const char of ZERO_WIDTH_CHARS) {
      normalized = normalized.split(char).join('');
    }
    return normalized;
  }

  /**
   * Get the next refusal phrase (non-repeating).
   */
  private getNextRefusal(): string {
    let index: number;
    if (REFUSAL_PHRASES.length <= 1) {
      index = 0;
    } else {
      // Ensure we don't repeat the last phrase
      do {
        index = Math.floor(Math.random() * REFUSAL_PHRASES.length);
      } while (index === this.lastRefusalIndex);
    }
    this.lastRefusalIndex = index;
    return REFUSAL_PHRASES[index];
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
