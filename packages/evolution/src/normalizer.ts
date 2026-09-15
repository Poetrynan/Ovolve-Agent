/**
 * @oa/evolution — Signal Normalizer
 *
 * Normalizes raw error messages and signal descriptions to enable
 * accurate clustering and signature generation.
 *
 * Normalization rules:
 * - Credential patterns → `<SECRET>`
 * - File paths → `<PATH>`
 * - Quoted strings → `<Q>`
 * - Hex IDs → `<HEX>`
 * - Numbers → `<N>`
 * - UUIDs → `<UUID>`
 * - Email addresses → `<EMAIL>`
 * - URLs → `<URL>`
 *
 * This ensures that the same error with different values (different file
 * paths, different IDs) maps to the same normalized form and thus the
 * same signature.
 */

// ---------------------------------------------------------------------------
// Normalization patterns (order matters — more specific first)
// ---------------------------------------------------------------------------

interface NormalizationRule {
  pattern: RegExp;
  replacement: string;
}

const NORMALIZATION_RULES: NormalizationRule[] = [
  // URLs (before paths, since URLs contain slashes)
  { pattern: /https?:\/\/[^\s'"<>]+/g, replacement: '<URL>' },

  // Email addresses
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: '<EMAIL>' },

  // UUIDs
  { pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, replacement: '<UUID>' },

  // Credential patterns (API keys, tokens, secrets)
  { pattern: /(?:api[_-]?key|apikey|secret[_-]?key|secretkey|access[_-]?token|accesstoken|auth[_-]?token|authtoken)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]+['"]?/gi, replacement: '<SECRET>' },
  { pattern: /Bearer\s+[A-Za-z0-9_\-\.]+/gi, replacement: 'Bearer <SECRET>' },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi, replacement: '<SECRET>' },
  { pattern: /sk-[A-Za-z0-9]{48,}/g, replacement: '<SECRET>' },
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, replacement: '<SECRET>' },

  // Hex IDs (at least 8 hex chars, often git hashes or IDs)
  { pattern: /\b[0-9a-f]{8,40}\b/gi, replacement: '<HEX>' },

  // Quoted strings (single, double, backtick)
  { pattern: /'[^']*'/g, replacement: '<Q>' },
  { pattern: /"[^"]*"/g, replacement: '<Q>' },
  { pattern: /`[^`]*`/g, replacement: '<Q>' },

  // File paths (Unix and Windows)
  { pattern: /(?:\/[\w.\-]+)+(?:\.[\w]+)?/g, replacement: '<PATH>' },
  { pattern: /(?:[A-Z]:\\(?:[^\\\s]+\\)*[^\\\s]+)/gi, replacement: '<PATH>' },

  // Numbers (integers and decimals, but not part of words)
  { pattern: /\b\d+\.?\d*\b/g, replacement: '<N>' },

  // IP addresses
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '<IP>' },

  // Timestamps (ISO 8601)
  { pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, replacement: '<TIMESTAMP>' },
];

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw signal message.
 *
 * Applies all normalization rules in order, then cleans up whitespace.
 *
 * @param rawMessage The raw error message or signal description.
 * @returns The normalized message with sensitive/variable data replaced.
 */
export function normalizeSignal(rawMessage: string): string {
  let normalized = rawMessage;

  for (const rule of NORMALIZATION_RULES) {
    normalized = normalized.replace(rule.pattern, rule.replacement);
  }

  // Clean up whitespace
  normalized = normalized
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}

/**
 * Normalize with metadata about what was replaced.
 *
 * Returns the normalized message plus a record of replacements made,
 * useful for debugging and audit.
 */
export function normalizeSignalDetailed(rawMessage: string): {
  normalized: string;
  replacements: Array<{ rule: string; count: number }>;
} {
  let normalized = rawMessage;
  const replacements: Array<{ rule: string; count: number }> = [];

  for (const rule of NORMALIZATION_RULES) {
    const matches = normalized.match(rule.pattern);
    if (matches && matches.length > 0) {
      replacements.push({ rule: rule.replacement, count: matches.length });
      normalized = normalized.replace(rule.pattern, rule.replacement);
    }
  }

  normalized = normalized.replace(/\s+/g, ' ').trim();

  return { normalized, replacements };
}

/**
 * Check if a message contains sensitive patterns that would be normalized.
 * Useful for pre-screening before logging or storing.
 */
export function containsSensitivePatterns(message: string): boolean {
  const sensitivePatterns = [
    /(?:api[_-]?key|apikey|secret[_-]?key|secretkey|access[_-]?token)\s*[:=]/i,
    /Bearer\s+[A-Za-z0-9_\-\.]{20,}/i,
    /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/i,
    /sk-[A-Za-z0-9]{48,}/,
    /gh[pousr]_[A-Za-z0-9_]{36,}/,
  ];

  return sensitivePatterns.some((p) => p.test(message));
}

/**
 * Extract the variable parts from a message (parts that would be normalized).
 * Returns the parts that differ between two instances of the same error.
 */
export function extractVariableParts(message: string): string[] {
  const variables: string[] = [];

  // Extract quoted strings
  const quoted = message.match(/'[^']*'|"[^"]*"|`[^`]*`/g);
  if (quoted) variables.push(...quoted);

  // Extract paths
  const paths = message.match(/(?:\/[\w.\-]+)+(?:\.[\w]+)?/g);
  if (paths) variables.push(...paths);

  // Extract numbers
  const numbers = message.match(/\b\d+\.?\d*\b/g);
  if (numbers) variables.push(...numbers);

  return Array.from(new Set(variables));
}
