/**
 * @oa/skills — SHA-256 Content Hash Versioning
 *
 * Computes and manages content hashes for skill files to enable:
 * - Change detection for hot-reloading
 * - Version tracking across imports
 * - Integrity verification
 *
 * Uses SHA-256 truncated to 16 hex characters (64 bits of collision resistance),
 * which is sufficient for change detection in a local skill repository.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ContentHashRecord } from './types';

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 content hash of a string.
 * Returns the first 16 hex characters.
 *
 * @param content The content to hash.
 * @returns 16-character hex string.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Compute the SHA-256 content hash of a file.
 * Returns the first 16 hex characters.
 *
 * @param filePath Path to the file.
 * @returns 16-character hex string, or null if file cannot be read.
 */
export function computeFileHash(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return computeContentHash(content);
  } catch {
    return null;
  }
}

/**
 * Verify that content matches an expected hash.
 *
 * @param content The content to verify.
 * @param expectedHash The expected hash.
 */
export function verifyContentHash(content: string, expectedHash: string): boolean {
  const actualHash = computeContentHash(content);
  return timingSafeCompare(actualHash, expectedHash);
}

/**
 * Timing-safe string comparison to prevent hash timing attacks.
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Hash record store
// ---------------------------------------------------------------------------

/**
 * In-memory store for content hash records.
 * Maps skill ID to its hash history.
 */
const hashStore = new Map<string, ContentHashRecord[]>();

/**
 * Record a new hash for a skill.
 *
 * @param skillId The skill identifier.
 * @param hash The new content hash.
 */
export function recordHash(skillId: string, hash: string): ContentHashRecord {
  const history = hashStore.get(skillId) ?? [];
  const previous = history.length > 0 ? history[history.length - 1] : undefined;

  const record: ContentHashRecord = {
    skillId,
    hash,
    previousHash: previous?.hash,
    computedAt: Date.now(),
  };

  history.push(record);
  hashStore.set(skillId, history);

  return record;
}

/**
 * Get the latest hash record for a skill.
 *
 * @param skillId The skill identifier.
 */
export function getLatestHash(skillId: string): ContentHashRecord | null {
  const history = hashStore.get(skillId);
  if (!history || history.length === 0) return null;
  return history[history.length - 1];
}

/**
 * Check if a skill's content has changed since its last recorded hash.
 *
 * @param skillId The skill identifier.
 * @param currentContent The current content to check.
 * @returns True if content has changed or no prior hash exists.
 */
export function hasContentChanged(skillId: string, currentContent: string): boolean {
  const latest = getLatestHash(skillId);
  if (!latest) return true; // No prior hash = treat as changed
  const currentHash = computeContentHash(currentContent);
  return currentHash !== latest.hash;
}

/**
 * Get the full hash history for a skill.
 *
 * @param skillId The skill identifier.
 */
export function getHashHistory(skillId: string): ContentHashRecord[] {
  return hashStore.get(skillId) ?? [];
}

/**
 * Clear hash records for a skill.
 *
 * @param skillId The skill identifier.
 */
export function clearHashRecords(skillId: string): void {
  hashStore.delete(skillId);
}

/**
 * Get all tracked skill IDs.
 */
export function getTrackedSkillIds(): string[] {
  return Array.from(hashStore.keys());
}
