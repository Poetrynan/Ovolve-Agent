/**
 * @oa/evolution — Signature Generation
 *
 * Generates deterministic signatures for signals to enable clustering
 * of similar failures. Signals with the same signature are grouped
 * together for proposal mining.
 *
 * Signature format: sha256(kind\x1ftool\x1fnormalized)[:16]
 *
 * The 16-hex-character prefix provides ~64 bits of collision resistance,
 * which is sufficient for clustering within a single agent's signal history.
 */

import { createHash } from 'node:crypto';
import type { SignalKind } from './types';

// ---------------------------------------------------------------------------
// Signature generation
// ---------------------------------------------------------------------------

/**
 * Generate a signature for a signal.
 *
 * The signature is computed from the signal kind, tool name (if any),
 * and the normalized message. This ensures that the same type of error
 * from the same tool with the same normalized message produces the same
 * signature, enabling clustering.
 *
 * Format: sha256(kind + \x1f + tool + \x1f + normalized)[:16]
 *
 * @param kind The signal kind.
 * @param toolName The tool name (or empty string if not tool-related).
 * @param normalizedMessage The normalized error message.
 * @returns 16-character hex signature.
 */
export function generateSignature(
  kind: SignalKind,
  toolName: string | undefined,
  normalizedMessage: string
): string {
  const tool = toolName ?? '';
  const data = `${kind}\x1f${tool}\x1f${normalizedMessage}`;
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/**
 * Generate a signature from a Signal-like object.
 */
export function generateSignatureFromObject(signal: {
  kind: SignalKind;
  toolName?: string;
  normalizedMessage: string;
}): string {
  return generateSignature(signal.kind, signal.toolName, signal.normalizedMessage);
}

// ---------------------------------------------------------------------------
// Signature comparison
// ---------------------------------------------------------------------------

/**
 * Check if two signatures match (identical).
 */
export function signaturesMatch(a: string, b: string): boolean {
  return a === b;
}

/**
 * Compute the similarity between two normalized messages.
 * Returns a value between 0 (completely different) and 1 (identical).
 *
 * Uses a simple token-overlap similarity (Jaccard index).
 */
export function computeMessageSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(/\s+/));
  const tokensB = new Set(b.split(/\s+/));

  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);

  if (union.size === 0) return 1.0;
  return intersection.size / union.size;
}

// ---------------------------------------------------------------------------
// Signature store (for clustering)
// ---------------------------------------------------------------------------

/**
 * A cluster of signals sharing the same signature.
 */
export interface SignatureCluster {
  signature: string;
  kind: SignalKind;
  toolName?: string;
  normalizedMessage: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  signalIds: string[];
}

/**
 * In-memory store for signature clusters.
 */
const clusterStore = new Map<string, SignatureCluster>();

/**
 * Add a signal to its signature cluster.
 */
export function addToCluster(
  signature: string,
  signal: {
    id: string;
    kind: SignalKind;
    toolName?: string;
    normalizedMessage: string;
    timestamp: number;
  }
): SignatureCluster {
  let cluster = clusterStore.get(signature);

  if (!cluster) {
    cluster = {
      signature,
      kind: signal.kind,
      toolName: signal.toolName,
      normalizedMessage: signal.normalizedMessage,
      count: 0,
      firstSeen: signal.timestamp,
      lastSeen: signal.timestamp,
      signalIds: [],
    };
    clusterStore.set(signature, cluster);
  }

  cluster.count++;
  cluster.lastSeen = signal.timestamp;
  cluster.signalIds.push(signal.id);

  return cluster;
}

/**
 * Get a signature cluster by signature.
 */
export function getCluster(signature: string): SignatureCluster | null {
  return clusterStore.get(signature) ?? null;
}

/**
 * Get all clusters with at least `minCount` signals.
 */
export function getClustersWithMinCount(minCount: number): SignatureCluster[] {
  return Array.from(clusterStore.values())
    .filter((c) => c.count >= minCount)
    .sort((a, b) => b.count - a.count);
}

/**
 * Get all clusters.
 */
export function getAllClusters(): SignatureCluster[] {
  return Array.from(clusterStore.values())
    .sort((a, b) => b.count - a.count);
}

/**
 * Remove a cluster.
 */
export function removeCluster(signature: string): void {
  clusterStore.delete(signature);
}

/**
 * Clear all clusters.
 */
export function clearClusters(): void {
  clusterStore.clear();
}

/**
 * Get cluster statistics.
 */
export function getClusterStats(): {
  totalClusters: number;
  totalSignals: number;
  largestCluster: number;
  averageClusterSize: number;
} {
  const clusters = Array.from(clusterStore.values());
  const totalSignals = clusters.reduce((sum, c) => sum + c.count, 0);
  const largestCluster = clusters.reduce((max, c) => Math.max(max, c.count), 0);

  return {
    totalClusters: clusters.length,
    totalSignals,
    largestCluster,
    averageClusterSize: clusters.length > 0 ? totalSignals / clusters.length : 0,
  };
}
