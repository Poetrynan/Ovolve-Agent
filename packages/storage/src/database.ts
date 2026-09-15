/**
 * @oa/storage — DatabaseManager
 * 
 * SQLite database manager using better-sqlite3. Provides:
 * - WAL mode with configurable busy_timeout
 * - Migration runner with namespace-based versioning
 * - Connection lifecycle management
 * - Transaction helpers
 * - Prepared statement caching
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  MigrationRecord,
  PreparedStatement,
  RunResult,
  StorageConfig,
  TransactionFn,
} from './types';

// ---------------------------------------------------------------------------
// Schema migrations table (for version tracking)
// ---------------------------------------------------------------------------

const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _schema_migrations (
    namespace TEXT NOT NULL,
    version   INTEGER NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, version)
  );
`;

// ---------------------------------------------------------------------------
// Default pragmas
// ---------------------------------------------------------------------------

const DEFAULT_PRAGMAS: Record<string, string | number> = {
  journal_mode: 'WAL',
  busy_timeout: 5000,
  foreign_keys: 'ON',
  synchronous: 'NORMAL',
  cache_size: -8000, // 8MB
  temp_store: 'MEMORY',
  mmap_size: 268435456, // 256MB
};

// ---------------------------------------------------------------------------
// DatabaseManager
// ---------------------------------------------------------------------------

export class DatabaseManager {
  private readonly config: Required<StorageConfig>;
  private db: Database.Database | null = null;
  private readonly statementCache: Map<string, PreparedStatement> = new Map();
  private isClosed: boolean = false;

  constructor(config: StorageConfig) {
    this.config = {
      dbPath: config.dbPath,
      busyTimeout: config.busyTimeout ?? 5000,
      walMode: config.walMode ?? true,
      foreignKeys: config.foreignKeys ?? true,
      autoMigrate: config.autoMigrate ?? true,
      pragmas: { ...DEFAULT_PRAGMAS, ...config.pragmas },
    };
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open the database connection.
   */
  open(): this {
    if (this.db) return this;

    // Ensure parent directory exists
    const dir = dirname(this.config.dbPath);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.config.dbPath);
    this.applyPragmas();
    this.ensureMigrationsTable();

    return this;
  }

  /**
   * Close the database connection and clear caches.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.statementCache.clear();
    this.isClosed = true;
  }

  /**
   * Check if the database connection is open.
   */
  get isOpen(): boolean {
    return this.db !== null && !this.isClosed;
  }

  // -------------------------------------------------------------------------
  // Direct database access (for repositories)
  // -------------------------------------------------------------------------

  /**
   * Get the underlying better-sqlite3 database instance.
   * @internal
   */
  get raw(): Database.Database {
    this.ensureOpen();
    return this.db!;
  }

  // -------------------------------------------------------------------------
  // Pragmas
  // -------------------------------------------------------------------------

  private applyPragmas(): void {
    this.ensureOpen();
    for (const [key, value] of Object.entries(this.config.pragmas)) {
      this.db!.pragma(`${key} = ${value}`);
    }
  }

  /**
   * Set a pragma at runtime.
   */
  setPragma(key: string, value: string | number): void {
    this.ensureOpen();
    this.db!.pragma(`${key} = ${value}`);
  }

  /**
   * Get the value of a pragma.
   */
  getPragma(key: string): string | number {
    this.ensureOpen();
    return this.db!.pragma(key, { simple: true }) as string | number;
  }

  // -------------------------------------------------------------------------
  // Statement management
  // -------------------------------------------------------------------------

  /**
   * Prepare a statement, with caching.
   */
  prepare(sql: string): PreparedStatement {
    this.ensureOpen();
    let stmt = this.statementCache.get(sql);
    if (!stmt) {
      stmt = this.db!.prepare(sql) as unknown as PreparedStatement;
      this.statementCache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Clear the statement cache.
   */
  clearStatementCache(): void {
    this.statementCache.clear();
  }

  // -------------------------------------------------------------------------
  // SQL execution helpers
  // -------------------------------------------------------------------------

  /**
   * Execute a single SQL statement (no parameters).
   */
  exec(sql: string): void {
    this.ensureOpen();
    this.db!.exec(sql);
  }

  /**
   * Run a prepared statement and return the result.
   */
  run(sql: string, ...params: unknown[]): RunResult {
    return this.prepare(sql).run(...params);
  }

  /**
   * Get a single row from a prepared statement.
   */
  get<T = unknown>(sql: string, ...params: unknown[]): T | null {
    const result = this.prepare(sql).get(...params);
    return (result as T) ?? null;
  }

  /**
   * Get all rows from a prepared statement.
   */
  all<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  /**
   * Execute a function within a transaction. The transaction is committed
   * if the function returns successfully, and rolled back if it throws.
   */
  transaction<T>(fn: TransactionFn<T>): T {
    this.ensureOpen();
    const txn = this.db!.transaction(fn);
    return txn();
  }

  /**
   * Execute a function within a deferred transaction.
   */
  deferredTransaction<T>(fn: TransactionFn<T>): T {
    this.ensureOpen();
    const txn = this.db!.transaction(fn);
    // better-sqlite3 transactions are deferred by default
    return txn();
  }

  /**
   * Begin an immediate transaction (acquires write lock immediately).
   */
  immediateTransaction<T>(fn: TransactionFn<T>): T {
    this.ensureOpen();
    this.db!.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db!.exec('COMMIT');
      return result;
    } catch (err) {
      this.db!.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Savepoint support for nested transactions.
   */
  savepoint<T>(name: string, fn: TransactionFn<T>): T {
    this.ensureOpen();
    this.db!.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.db!.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      this.db!.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Migration runner
  // -------------------------------------------------------------------------

  private ensureMigrationsTable(): void {
    this.db!.exec(MIGRATIONS_TABLE_SQL);
  }

  /**
   * Get the current schema version for a namespace.
   */
  getSchemaVersion(namespace: string): number {
    this.ensureOpen();
    const row = this.db!.prepare(
      'SELECT MAX(version) as version FROM _schema_migrations WHERE namespace = ?'
    ).get(namespace) as { version: number | null };
    return row.version ?? 0;
  }

  /**
   * Set the schema version for a namespace.
   */
  setSchemaVersion(namespace: string, version: number): void {
    this.ensureOpen();
    this.db!.prepare(
      'INSERT OR REPLACE INTO _schema_migrations (namespace, version, applied_at) VALUES (?, ?, ?)'
    ).run(namespace, version, Date.now() * 1000);
  }

  /**
   * Run migrations for a namespace.
   */
  migrate(
    namespace: string,
    migrations: { version: number; name: string; sql: string }[]
  ): void {
    this.ensureOpen();
    const currentVersion = this.getSchemaVersion(namespace);

    const pending = migrations
      .filter((m) => m.version > currentVersion)
      .sort((a, b) => a.version - b.version);

    if (pending.length === 0) return;

    const runMigrations = this.db!.transaction(() => {
      for (const migration of pending) {
        this.db!.exec(migration.sql);
        this.setSchemaVersion(namespace, migration.version);
      }
    });

    runMigrations();
  }

  /**
   * Get all applied migrations for a namespace.
   */
  getAppliedMigrations(namespace: string): MigrationRecord[] {
    this.ensureOpen();
    return this.db!.prepare(
      'SELECT namespace, version, applied_at FROM _schema_migrations WHERE namespace = ? ORDER BY version'
    ).all(namespace) as MigrationRecord[];
  }

  // -------------------------------------------------------------------------
  // WAL management
  // -------------------------------------------------------------------------

  /**
   * Checkpoint the WAL file.
   */
  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE'): void {
    this.ensureOpen();
    this.db!.pragma(`wal_checkpoint(${mode})`);
  }

  /**
   * Get the current WAL file size in bytes.
   */
  getWalSize(): number {
    this.ensureOpen();
    const row = this.db!.prepare(
      'SELECT total_size FROM pragma_wal_checkpoint_info'
    ).get() as { total_size: number } | undefined;
    return row?.total_size ?? 0;
  }

  // -------------------------------------------------------------------------
  // Integrity
  // -------------------------------------------------------------------------

  /**
   * Run an integrity check on the database.
   */
  integrityCheck(): { ok: boolean; errors: string[] } {
    this.ensureOpen();
    const results = this.db!.pragma('integrity_check') as string[];
    const errors = results.filter((r) => r !== 'ok');
    return { ok: errors.length === 0, errors };
  }

  /**
   * Run a quick integrity check.
   */
  quickCheck(): boolean {
    this.ensureOpen();
    const result = this.db!.pragma('quick_check', { simple: true }) as string;
    return result === 'ok';
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  /**
   * Get the number of rows changed by the last statement.
   */
  getChanges(): number {
    this.ensureOpen();
    return this.db!.changes;
  }

  /**
   * Get the last inserted rowid.
   */
  getLastInsertRowid(): number {
    this.ensureOpen();
    return Number(this.db!.lastInsertRowid);
  }

  /**
   * Execute a function and measure its duration.
   */
  measure<T>(fn: () => T): { result: T; durationMs: number } {
    const start = performance.now();
    const result = fn();
    const durationMs = performance.now() - start;
    return { result, durationMs };
  }

  /**
   * Vacuum the database to reclaim space.
   */
  vacuum(): void {
    this.ensureOpen();
    this.db!.exec('VACUUM');
  }

  /**
   * Vacuum the database into a new file.
   */
  vacuumInto(targetPath: string): void {
    this.ensureOpen();
    this.db!.exec(`VACUUM INTO '${targetPath}'`);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private ensureOpen(): void {
    if (!this.db || this.isClosed) {
      throw new Error('Database connection is not open. Call open() first.');
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDatabase(config: StorageConfig): DatabaseManager {
  const manager = new DatabaseManager(config);
  manager.open();
  return manager;
}
