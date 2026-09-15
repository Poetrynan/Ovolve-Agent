/**
 * @oa/compaction — Summary Quality Audit
 *
 * Audits folded summaries to ensure critical information is preserved.
 * Checks identifier retention (function names, file paths, URLs, etc.)
 * and produces a quality score. Enforces a minimum 30% identifier retention.
 */

import type { CompactionMessage, QualityAuditResult } from './types';

// ---------------------------------------------------------------------------
// Identifier extraction patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that identify important tokens which should survive compaction.
 * These include code identifiers, paths, URLs, error codes, and key terms.
 */
const IDENTIFIER_PATTERNS = [
  // Function/method names: fooBar, foo_bar, FooBar
  /\b[A-Z][a-zA-Z0-9]{2,}\b/g,                    // PascalCase
  /\b[a-z]+_[a-z_]+\b/g,                           // snake_case identifiers
  /\b[a-z]{2,}[A-Z][a-zA-Z]*\b/g,                  // camelCase

  // File paths and extensions
  /(?:[\w\-./\\]+)\.(?:ts|tsx|js|jsx|py|rs|go|java|cpp|c|h|json|yaml|yml|toml|md|txt|csv|html|css|sql|sh|bat|ps1)/gi,

  // URLs
  /https?:\/\/[^\s)]+/gi,

  // Error codes and hex values
  /\b0x[0-9a-fA-F]+\b/g,
  /\b[A-Z]{2,}_ERROR\b/g,
  /\bERR_[A-Z_]+\b/g,

  // UUIDs
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,

  // Environment variables and config keys
  /\b[A-Z_]{3,}\b/g,

  // Package/module names
  /@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/g,

  // Git hashes (short and long)
  /\b[0-9a-f]{7,40}\b/gi,

  // Version numbers
  /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g,

  // Email addresses
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
];

/**
 * Extract identifiers from text content.
 */
function extractIdentifiers(text: string): string[] {
  const identifiers = new Set<string>();
  for (const pattern of IDENTIFIER_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const match of matches) {
        // Filter out very short or common words
        if (match.length >= 3 && !isCommonWord(match)) {
          identifiers.add(match);
        }
      }
    }
  }
  return Array.from(identifiers);
}

/**
 * Check if a word is a common English word that shouldn't count as an identifier.
 */
function isCommonWord(word: string): boolean {
  const common = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
    'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its', 'may',
    'new', 'now', 'old', 'see', 'way', 'who', 'did', 'get', 'let', 'say',
    'she', 'too', 'use', 'JSON', 'HTML', 'HTTP', 'POST', 'GET', 'DELETE',
    'PUT', 'PATCH', 'URL', 'API', 'CLI', 'CSS', 'SQL', 'ENV', 'PATH',
    'POST', 'GET', 'DELETE', 'PATCH', 'JSON', 'HTML', 'STRING', 'NUMBER',
    'BOOLEAN', 'ARRAY', 'OBJECT', 'FUNCTION', 'CLASS', 'IMPORT', 'EXPORT',
    'DEFAULT', 'RETURN', 'CONST', 'LONG', 'THIS', 'THAT', 'WITH', 'FROM',
    'TYPE', 'VOID', 'NULL', 'TRUE', 'FALSE',
  ]);
  return common.has(word.toLowerCase()) || common.has(word);
}

// ---------------------------------------------------------------------------
// Quality audit
// ---------------------------------------------------------------------------

/**
 * Audit the quality of a folded result against the original messages.
 *
 * Compares identifiers present in the original messages against those
 * preserved in the folded result. Produces a quality score and pass/fail.
 *
 * @param original The original messages before folding.
 * @param folded The messages after folding.
 * @param minRetention Minimum identifier retention ratio (0-1).
 */
export function auditQuality(
  original: CompactionMessage[],
  folded: CompactionMessage[],
  minRetention: number = 0.3
): QualityAuditResult {
  // Extract identifiers from original
  const originalText = original.map((m) => m.content).join('\n');
  const originalIds = extractIdentifiers(originalText);

  // Extract identifiers from folded result
  const foldedText = folded.map((m) => m.content).join('\n');
  const foldedIds = new Set(extractIdentifiers(foldedText));

  // Determine which identifiers were preserved
  const preservedIdentifiers = originalIds.filter((id) => foldedIds.has(id));
  const lostIdentifiers = originalIds.filter((id) => !foldedIds.has(id));

  // Calculate retention ratio
  const identifierRetention = originalIds.length > 0
    ? preservedIdentifiers.length / originalIds.length
    : 1.0; // No identifiers = nothing to lose

  // Calculate overall quality score (combines retention with content ratio)
  const contentRatio = foldedText.length / Math.max(originalText.length, 1);
  const qualityScore = Math.min(1.0, (identifierRetention * 0.7) + (contentRatio * 0.3));

  // Pass/fail based on minimum retention threshold
  const passed = identifierRetention >= minRetention;

  // Build human-readable message
  const retentionPercent = Math.round(identifierRetention * 100);
  const message = passed
    ? `Quality audit PASSED: ${retentionPercent}% identifiers preserved (${preservedIdentifiers.length}/${originalIds.length})`
    : `Quality audit FAILED: only ${retentionPercent}% identifiers preserved (minimum ${Math.round(minRetention * 100)}%)`;

  return {
    passed,
    identifierRetention,
    originalIdentifiers: originalIds,
    preservedIdentifiers,
    lostIdentifiers,
    qualityScore,
    message,
  };
}

/**
 * Check if content has sufficient identifier density to warrant audit.
 * Very short content may skip audit.
 */
export function shouldAudit(messages: CompactionMessage[]): boolean {
  const totalLength = messages.reduce((sum, m) => sum + m.content.length, 0);
  return totalLength >= 50; // At least 50 chars to audit
}
