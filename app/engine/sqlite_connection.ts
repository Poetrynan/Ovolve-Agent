/**
 * sqlite_connection.ts — the Python `sqlite3` connection shape, on `node:sqlite`.
 *
 * The ported stores call `db.execute(sql, params).fetchone()` / `.fetchall()`,
 * which is Python's `sqlite3` API. Node's `node:sqlite` exposes
 * `prepare(sql).get(...)` / `.all(...)` instead. Rather than rewrite every call
 * site — which would bury the ported logic under API translation and make the
 * diff unreadable — this adapter presents the source's shape and maps it once.
 *
 * RULEBOOK CITATIONS
 *   §1  uses a Node builtin, so no dependency row is needed
 *   §2  broad swallow: `commit()` and `close()` are no-ops here, because
 *       node:sqlite autocommits and the source's commit points carry no
 *       behaviour of their own
 *   §4  naming: new support module; not a source unit
 *
 * PORT STATUS: n/a (support module, not a translated unit)
 */

import { DatabaseSync } from "node:sqlite";

/** What a row looks like coming back from a query. */
export type Row = Record<string, unknown>;

/** The result of one `execute`, mirroring Python's `Cursor` for the calls used. */
export interface SqliteCursor {
  fetchone(): Row | null;
  fetchall(): Row[];
  readonly rowcount: number;
  /** Python cursor.lastrowid — the rowid of the last INSERT (node:sqlite lastInsertRowid). */
  readonly lastrowid: number | bigint;
}

/** The connection surface the ported stores use. */
export interface SqliteConnection {
  execute(sql: string, params?: readonly unknown[]): SqliteCursor;
  commit(): void;
  close(): void;
}

/**
 * `node:sqlite` rows are plain objects, and a missing column reads as
 * `undefined` rather than raising. Python's `sqlite3.Row` raises `IndexError`
 * for a missing key, which is what the source's `_opt` fallbacks are written
 * against. `null` is returned here for a missing key so a caller's `?? ""` and a
 * Python caller's `except IndexError` land in the same place.
 */
function normalizeRow(row: unknown): Row | null {
  if (row === null || row === undefined) {
    return null;
  }
  return row as Row;
}

class Cursor implements SqliteCursor {
  private _stmt: ReturnType<DatabaseSync["prepare"]>;
  private _params: readonly unknown[];
  rowcount = 0;
  lastrowid: number | bigint = 0;

  constructor(stmt: ReturnType<DatabaseSync["prepare"]>, params: readonly unknown[]) {
    this._stmt = stmt;
    this._params = params;
  }

  fetchone(): Row | null {
    return normalizeRow(this._stmt.get(...(this._params as unknown[])));
  }

  fetchall(): Row[] {
    return this._stmt.all(...(this._params as unknown[])).map((r) => normalizeRow(r) ?? {});
  }
}

class Connection implements SqliteConnection {
  private _db: DatabaseSync;

  constructor(path: string) {
    this._db = new DatabaseSync(path);
  }

  execute(sql: string, params: readonly unknown[] = []): SqliteCursor {
    const stmt = this._db.prepare(sql);
    // node:sqlite has no separate execute-for-DML step, so the statement is run
    // when it cannot produce rows. `all()` on a DML statement would throw.
    const isQuery = /^\s*(?:select|with|pragma)\b/i.test(sql);
    if (!isQuery) {
      const info = stmt.run(...(params as unknown[]));
      const cur = new Cursor(stmt, []);
      cur.rowcount = Number(info.changes ?? 0);
      cur.lastrowid = info.lastInsertRowid;
      return cur;
    }
    return new Cursor(stmt, params);
  }

  /**
   * RULEBOOK §2: `node:sqlite` runs each statement in its own transaction, so
   * the source's explicit `commit()` points have nothing left to do. Kept as a
   * method rather than removed, so every ported call site reads unchanged.
   */
  commit(): void {
    /* no-op: node:sqlite autocommits per statement */
  }

  close(): void {
    this._db.close();
  }
}

/** Open a connection. `:memory:` and file paths both work. */
export function openSqlite(path: string): SqliteConnection {
  return new Connection(path);
}
