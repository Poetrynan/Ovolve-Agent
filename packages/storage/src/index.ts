/**
 * @oa/storage — Public Exports
 * 
 * SQLite storage layer for OvolveAgent.
 * 
 * @example
 * ```ts
 * import { createStorage, DatabaseManager } from '@oa/storage';
 * 
 * const storage = createStorage({ dbPath: './data/agent.db' });
 * const sessions = storage.repositories.sessions;
 * 
 * sessions.create({
 *   id: 'sess_123',
 *   title: 'New Session',
 *   archived: 0,
 *   deleted: 0,
 *   phase: 'idle',
 *   last_seq: 0,
 *   last_event_timestamp: Date.now() * 1000,
 *   event_count: 0,
 *   message_count: 0,
 *   error_count: 0,
 *   last_error: null,
 *   metadata: '{}',
 *   created_at: Date.now() * 1000,
 *   updated_at: Date.now() * 1000,
 * });
 * ```
 */

// Database core
export {
  DatabaseManager,
  createDatabase,
} from './database';

// Types
export type {
  StorageConfig,
  SessionRecord,
  EventRecord,
  FileSnapshotRecord,
  CheckpointRecord,
  MemoryEntryRecord,
  MigrationRecord,
  PaginationOptions,
  TimeRangeOptions,
  ListSessionsOptions,
  ListEventsOptions,
  ListFileSnapshotsOptions,
  ListCheckpointsOptions,
  ListMemoryOptions,
  VectorSearchOptions,
  VectorSearchResult,
  TransactionFn,
  PreparedStatement,
  RunResult,
} from './types';

// Repositories
export {
  SessionsRepository,
  createSessionsRepository,
  SESSIONS_TABLE_SQL,
  SESSIONS_MIGRATIONS,
} from './repositories/sessions';

export {
  EventsRepository,
  createEventsRepository,
} from './repositories/events';

export {
  FileSnapshotsRepository,
  createFileSnapshotsRepository,
  FILE_SNAPSHOTS_TABLE_SQL,
  FILE_SNAPSHOTS_MIGRATIONS,
} from './repositories/file-snapshots';

export {
  CheckpointsRepository,
  createCheckpointsRepository,
} from './repositories/checkpoints';

export {
  MemoryRepository,
  createMemoryRepository,
  MEMORY_TABLE_SQL,
  MEMORY_MIGRATIONS,
} from './repositories/memory';

// ---------------------------------------------------------------------------
// Storage facade — bundles all repositories
// ---------------------------------------------------------------------------

import type { StorageConfig } from './types';
import { DatabaseManager, createDatabase } from './database';
import { SessionsRepository, createSessionsRepository } from './repositories/sessions';
import { EventsRepository, createEventsRepository } from './repositories/events';
import { FileSnapshotsRepository, createFileSnapshotsRepository } from './repositories/file-snapshots';
import { CheckpointsRepository, createCheckpointsRepository } from './repositories/checkpoints';
import { MemoryRepository, createMemoryRepository } from './repositories/memory';

export interface Storage {
  /** The underlying database manager. */
  database: DatabaseManager;
  /** All repositories. */
  repositories: {
    sessions: SessionsRepository;
    events: EventsRepository;
    fileSnapshots: FileSnapshotsRepository;
    checkpoints: CheckpointsRepository;
    memory: MemoryRepository;
  };
  /** Close the storage and release resources. */
  close(): void;
}

export interface CreateStorageConfig extends StorageConfig {
  /** Lazy-init repositories on first access (default: false). */
  lazyRepositories?: boolean;
}

/**
 * Create a fully initialized storage instance with all repositories.
 */
export function createStorage(config: CreateStorageConfig): Storage {
  const db = createDatabase(config);

  if (config.lazyRepositories) {
    // Lazy initialization — repositories created on first access
    let _sessions: SessionsRepository | null = null;
    let _events: EventsRepository | null = null;
    let _fileSnapshots: FileSnapshotsRepository | null = null;
    let _checkpoints: CheckpointsRepository | null = null;
    let _memory: MemoryRepository | null = null;

    return {
      database: db,
      get repositories() {
        return {
          get sessions() {
            if (!_sessions) _sessions = createSessionsRepository(db);
            return _sessions;
          },
          get events() {
            if (!_events) _events = createEventsRepository(db);
            return _events;
          },
          get fileSnapshots() {
            if (!_fileSnapshots) _fileSnapshots = createFileSnapshotsRepository(db);
            return _fileSnapshots;
          },
          get checkpoints() {
            if (!_checkpoints) _checkpoints = createCheckpointsRepository(db);
            return _checkpoints;
          },
          get memory() {
            if (!_memory) _memory = createMemoryRepository(db);
            return _memory;
          },
        };
      },
      close() {
        db.close();
      },
    };
  }

  // Eager initialization — all repositories created immediately
  const repositories = {
    sessions: createSessionsRepository(db),
    events: createEventsRepository(db),
    fileSnapshots: createFileSnapshotsRepository(db),
    checkpoints: createCheckpointsRepository(db),
    memory: createMemoryRepository(db),
  };

  return {
    database: db,
    repositories,
    close() {
      db.close();
    },
  };
}
