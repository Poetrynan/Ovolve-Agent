/**
 * storage_types.ts — shared types for the storage subsystem.
 *
 * RULEBOOK CITATIONS
 *   §4  home module for shared types used across the storage split; the
 *       storage unit is one source module, so its internal shared shapes live
 *       beside it instead of polluting engine/types.ts.
 *   §2  `dict` payloads are plain Record<string, unknown> unless order is
 *       load-bearing (it is not for any storage payload).
 *
 * PORT STATUS: n/a (support module of the storage unit, not a translated unit)
 */

/** What a row looks like coming back from a query (see sqlite_connection). */
export type Row = Record<string, unknown>;

/** A JSON-serializable dict, the shape most storage payloads carry. */
export type JsonDict = Record<string, unknown>;

/** Result of a split_usage_model_id call: [provider_id, model_id]. */
export interface SplitModelId {
  providerId: string;
  modelId: string;
}

/** Migration journal on disk (migration_journal.json). */
export interface MigrationJournal {
  backup_dir?: string;
  steps?: MigrationJournalStep[];
  updated_at?: number;
  [k: string]: unknown;
}

export interface MigrationJournalStep {
  id: string;
  description?: string;
  status?: string;
  error?: string;
  started_at?: number;
  finished_at?: number;
  [k: string]: unknown;
}

/** migration_status() result. */
export interface MigrationStatus {
  applied: JsonDict[];
  pending: { id: string; description: string }[];
  deferred: JsonDict[];
  registered: number;
  appVersion: string;
  recoveryMode: string;
  journal: {
    path: string;
    backupDir: string;
    steps: MigrationJournalStep[];
  };
}

/** retry_deferred_migration() result. */
export interface RetryResult {
  ok: boolean;
  results: JsonDict[];
  error: string;
}
